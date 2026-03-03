const express = require('express');
const { getConnection, requireAuth } = require('./auth');

const router = express.Router();

/** Extract a readable error message from various error formats (jsforce, SOAP, etc.) */
function getErrorMessage(err) {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (err.message) return err.message;
  if (err.body?.message) return err.body.message;
  if (err.body?.faultstring) return err.body.faultstring;
  if (Array.isArray(err)) return err.map((e) => getErrorMessage(e)).join('; ');
  return String(err);
}

/**
 * Apply optional namespace replacement to an API name.
 * e.g. MaicaCare__Client__c -> Maica__Client__c when { source: 'MaicaCare', target: 'Maica' }
 */
function applyNamespace(apiName, namespaceReplacement) {
  if (!apiName || !namespaceReplacement?.source || !namespaceReplacement?.target) return apiName;
  const src = namespaceReplacement.source;
  const tgt = namespaceReplacement.target;
  if (apiName.startsWith(src + '__')) {
    return tgt + '__' + apiName.slice(src.length + 2);
  }
  return apiName;
}

/**
 * Map schema field type to Metadata API CustomField type and build metadata.
 */
function buildFieldMetadata(sourceField, objectFullName, namespaceReplacement) {
  const fieldApiName = applyNamespace(sourceField.apiName, namespaceReplacement);
  const fullName = `${objectFullName}.${fieldApiName}`;

  const base = {
    fullName,
    label: sourceField.label || fieldApiName,
    required: sourceField.required === true,
    externalId: sourceField.externalId === true,
    unique: sourceField.unique === true,
  };

  const type = (sourceField.type || 'string').toLowerCase();

  switch (type) {
    case 'string':
      return { ...base, type: 'Text', length: Math.min(Math.max(sourceField.length || 255, 1), 255) };
    case 'textarea':
      return { ...base, type: 'LongTextArea', length: Math.min(Math.max(sourceField.length || 32768), 131072) };
    case 'int':
      return { ...base, type: 'Number', precision: sourceField.precision ?? 10, scale: 0 };
    case 'double':
    case 'currency':
      return {
        ...base,
        type: type === 'currency' ? 'Currency' : 'Number',
        precision: sourceField.precision ?? 18,
        scale: sourceField.scale ?? 2,
      };
    case 'boolean':
      return { ...base, type: 'Checkbox', defaultValue: sourceField.defaultValue === 'true' };
    case 'date':
      return { ...base, type: 'Date' };
    case 'datetime':
      return { ...base, type: 'DateTime' };
    case 'picklist': {
      const values = (sourceField.picklistValues || []).map((p) => ({
        fullName: p.value,
        label: p.label ?? p.value,
        default: false,
      }));
      return {
        ...base,
        type: 'Picklist',
        valueSet: {
          restricted: true,
          valueSetDefinition: { sorted: false, value: values },
        },
      };
    }
    case 'multipicklist': {
      const values = (sourceField.picklistValues || []).map((p) => ({
        fullName: p.value,
        label: p.label ?? p.value,
        default: false,
      }));
      return {
        ...base,
        type: 'MultiselectPicklist',
        valueSet: {
          restricted: true,
          valueSetDefinition: { sorted: false, value: values },
        },
      };
    }
    case 'reference':
    case 'lookup': {
      const refTo = sourceField.referenceTo?.[0];
      if (!refTo) return null;
      const refObject = applyNamespace(refTo, namespaceReplacement);
      return {
        ...base,
        type: 'Lookup',
        referenceTo: refObject,
        relationshipName: sourceField.apiName?.replace(/__c$/, '__r') || undefined,
      };
    }
    case 'id':
      return null; // System field, skip
    case 'email':
      return { ...base, type: 'Email' };
    case 'url':
      return { ...base, type: 'Url' };
    case 'phone':
      return { ...base, type: 'Phone' };
    case 'percent':
      return {
        ...base,
        type: 'Percent',
        precision: sourceField.precision ?? 5,
        scale: sourceField.scale ?? 2,
      };
    default:
      return { ...base, type: 'Text', length: 255 };
  }
}

/**
 * Build CustomObject metadata for a new object.
 */
function buildObjectMetadata(sourceObject, namespaceReplacement) {
  const fullName = applyNamespace(sourceObject.apiName, namespaceReplacement);
  return {
    fullName,
    label: sourceObject.label || fullName,
    pluralLabel: sourceObject.labelPlural || (sourceObject.label || fullName) + 's',
    deploymentStatus: 'Deployed',
    sharingModel: 'ReadWrite',
    nameField: {
      type: 'Text',
      label: sourceObject.label || fullName + ' Name',
    },
  };
}

/**
 * GET /api/source/record-counts
 * Get record count per object in the source org.
 */
router.get('/source/record-counts', requireAuth('source'), async (req, res) => {
  try {
    const conn = getConnection(req, 'source');
    if (!conn) return res.status(401).json({ error: 'Not connected to source org' });

    const { objects } = req.query;
    const objectList = objects ? JSON.parse(objects) : [];
    if (!objectList.length) {
      return res.json({ objects: [] });
    }

    const results = [];
    for (const apiName of objectList) {
      try {
        const q = await conn.query(`SELECT COUNT() FROM ${apiName}`);
        results.push({ apiName, count: q?.totalSize ?? 0 });
      } catch {
        results.push({ apiName, count: null });
      }
    }
    res.json({ objects: results });
  } catch (err) {
    console.error('Record counts error:', err);
    res.status(500).json({ error: err.message || 'Failed to get record counts' });
  }
});

/**
 * POST /api/migration/execute
 * Execute the migration plan: create objects and fields in the target org.
 * Streams NDJSON progress events.
 */
router.post(
  '/migration/execute',
  requireAuth('source'),
  requireAuth('target'),
  async (req, res) => {
    const { objectMappings, sourceSchema, targetSchema, namespaceReplacement } = req.body || {};

    if (!objectMappings?.length) {
      return res.status(400).json({ error: 'No object mappings provided' });
    }

    const conn = getConnection(req, 'target');
    if (!conn) {
      return res.status(401).json({ error: 'Not connected to target org' });
    }

    if (!conn.metadata) {
      return res.status(500).json({ error: 'Metadata API not available on connection' });
    }

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (obj) => {
      res.write(JSON.stringify(obj) + '\n');
      if (typeof res.flush === 'function') res.flush();
    };

    let objectsCreated = 0;
    let fieldsCreated = 0;

    try {
      const toProcess = objectMappings.filter(
        (om) => om.objectAction === 'create' || (om.objectAction === 'map' && om.target)
      );

      let totalSteps = 0;
      for (const om of toProcess) {
        if (om.objectAction === 'create') totalSteps += 1;
        else if (om.objectAction === 'map' && om.target)
          totalSteps += (om.fieldMappings || []).filter((fm) => fm.action === 'create' && fm.source).length;
      }

      send({ type: 'start', message: 'Starting migration...', totalSteps, percent: 0 });

      let stepIndex = 0;
      const sendProgress = (msg, extra = {}) => {
        send({ type: 'progress', message: msg, ...extra });
      };
      const advanceProgress = (msg, extra = {}) => {
        stepIndex += 1;
        const pct = totalSteps > 0 ? Math.min(100, Math.round((stepIndex / totalSteps) * 100)) : 0;
        send({ type: 'progress', message: msg, step: stepIndex, totalSteps, percent: pct, ...extra });
      };

      for (let i = 0; i < toProcess.length; i++) {
        const om = toProcess[i];
        const src = om.source;
        const tgt = om.target;

        if (om.objectAction === 'create') {
          const objFullName = applyNamespace(src.apiName, namespaceReplacement);
          sendProgress(`Creating object ${objFullName}...`, { object: objFullName });

          const objMeta = buildObjectMetadata(src, namespaceReplacement);
          const fieldsToCreate = (om.fieldMappings || [])
            .filter((fm) => fm.action === 'create' && fm.source)
            .map((fm) => fm.source);

          const fieldMetas = [];
          for (const f of fieldsToCreate) {
            const meta = buildFieldMetadata(f, objFullName, namespaceReplacement);
            if (meta) fieldMetas.push(meta);
          }

          if (fieldMetas.length) {
            objMeta.fields = fieldMetas;
          }

          try {
            await conn.metadata.create('CustomObject', objMeta);
            objectsCreated += 1;
            fieldsCreated += fieldMetas.length;
            advanceProgress(`Created ${objFullName} with ${fieldMetas.length} fields`, {
              object: objFullName,
              fieldsCount: fieldMetas.length,
            });
          } catch (err) {
            const msg = getErrorMessage(err);
            const fullMsg = `Failed to create object ${objFullName}: ${msg}`;
            console.error('Migration object create error:', fullMsg, err);
            send({
              type: 'error',
              message: fullMsg,
              object: objFullName,
              error: msg,
            });
            throw err;
          }
        } else if (om.objectAction === 'map' && tgt) {
          const objFullName = tgt.apiName;
          const fieldsToCreate = (om.fieldMappings || []).filter(
            (fm) => fm.action === 'create' && fm.source
          );

          for (const fm of fieldsToCreate) {
            const meta = buildFieldMetadata(fm.source, objFullName, namespaceReplacement);
            if (!meta) continue;

            sendProgress(`Creating field ${meta.fullName}...`, {
              object: objFullName,
              field: meta.fullName,
            });

            try {
              await conn.metadata.create('CustomField', meta);
              fieldsCreated += 1;
              advanceProgress(`Created field ${meta.fullName}`, {
                object: objFullName,
                field: meta.fullName,
              });
            } catch (err) {
              const msg = getErrorMessage(err);
              const fullMsg = `Failed to create field ${meta.fullName}: ${msg}`;
              console.error('Migration field create error:', fullMsg, err);
              send({
                type: 'error',
                message: fullMsg,
                object: objFullName,
                field: meta.fullName,
                error: msg,
              });
              throw err;
            }
          }
        }
      }

      send({
        type: 'complete',
        objectsCreated,
        fieldsCreated,
        message: `Migration complete. Created ${objectsCreated} object(s) and ${fieldsCreated} field(s).`,
      });
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error('Migration execute error:', msg, err);
      send({
        type: 'error',
        message: msg,
        error: msg,
        objectsCreated,
        fieldsCreated,
      });
    } finally {
      res.end();
    }
  }
);

module.exports = router;
