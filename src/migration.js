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
      const baseName = (sourceField.apiName || '').replace(/__c$/, '') || 'Lookup';
      const objPart = (objectFullName || '').replace(/__c$/, '').replace(/__/g, '_');
      const relName = `${objPart}_${baseName}`.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'Rel';
      return {
        ...base,
        type: 'Lookup',
        referenceTo: refObject,
        relationshipName: relName,
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
 * Get the full API name for an object from its mapping (create or map).
 */
function getObjectFullName(om, namespaceReplacement) {
  if (om.objectAction === 'create' && om.source) {
    return applyNamespace(om.source.apiName, namespaceReplacement);
  }
  if (om.objectAction === 'map' && om.target) {
    return om.target.apiName;
  }
  return null;
}

/**
 * Topologically sort object mappings so that objects referenced by Lookups are created first.
 */
function sortByDependencies(toProcess, namespaceReplacement) {
  const nameToIndex = new Map();
  toProcess.forEach((om, i) => {
    const name = getObjectFullName(om, namespaceReplacement);
    if (name) nameToIndex.set(name, i);
  });

  const getRefs = (om) => {
    const refs = [];
    for (const fm of om.fieldMappings || []) {
      const f = fm.source || fm;
      if ((f.type || '').toLowerCase() !== 'reference' && (f.type || '').toLowerCase() !== 'lookup') continue;
      const refTo = f.referenceTo?.[0];
      if (!refTo) continue;
      const refName = applyNamespace(refTo, namespaceReplacement);
      if (refName.endsWith('__c') && refName !== getObjectFullName(om, namespaceReplacement)) {
        refs.push(refName);
      }
    }
    return refs;
  };

  const sorted = [];
  const visited = new Set();
  const visiting = new Set();

  function visit(i) {
    if (visited.has(i)) return;
    if (visiting.has(i)) return; // cycle, ignore
    visiting.add(i);
    const om = toProcess[i];
    const refs = getRefs(om);
    for (const refName of refs) {
      const j = nameToIndex.get(refName);
      if (j != null && j !== i) visit(j);
    }
    visiting.delete(i);
    visited.add(i);
    sorted.push(i);
  }

  for (let i = 0; i < toProcess.length; i++) visit(i);
  return sorted.map((i) => toProcess[i]);
}

/**
 * Check if a Lookup field should be skipped because its referenced object is not in the migration.
 */
function shouldSkipLookupField(sourceField, objectsBeingCreated, namespaceReplacement) {
  const type = (sourceField.type || '').toLowerCase();
  if (type !== 'reference' && type !== 'lookup') return false;
  const refTo = sourceField.referenceTo?.[0];
  if (!refTo) return false;
  const refName = applyNamespace(refTo, namespaceReplacement);
  if (!refName.endsWith('__c')) return false; // standard object, always exists
  return !objectsBeingCreated.has(refName);
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
      label: 'Name',
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
      let toProcess = objectMappings.filter(
        (om) => om.objectAction === 'create' || (om.objectAction === 'map' && om.target)
      );

      const objectsBeingCreated = new Set(
        toProcess.map((om) => getObjectFullName(om, namespaceReplacement)).filter(Boolean)
      );
      toProcess = sortByDependencies(toProcess, namespaceReplacement);

      let totalSteps = 0;
      for (const om of toProcess) {
        if (om.objectAction === 'create') {
          totalSteps += 1;
          const createFields = (om.fieldMappings || []).filter((fm) => fm.action === 'create' && fm.source);
          totalSteps += createFields.length;
        } else if (om.objectAction === 'map' && om.target)
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

          try {
            const createResult = await conn.metadata.create('CustomObject', objMeta);
            const results = Array.isArray(createResult) ? createResult : [createResult];
            const failed = results.find((r) => r && r.success === false);
            if (failed && (failed.errors?.length || failed.fullName)) {
              const errMsg = (failed.errors || []).map((e) => e.message || e.statusCode || String(e)).join('; ') || `Create failed for ${failed.fullName || objFullName}`;
              throw new Error(errMsg);
            }
            objectsCreated += 1;
            advanceProgress(`Created object ${objFullName}`, { object: objFullName });
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

          for (const f of fieldsToCreate) {
            if (shouldSkipLookupField(f, objectsBeingCreated, namespaceReplacement)) {
              const refTo = applyNamespace(f.referenceTo?.[0], namespaceReplacement);
              advanceProgress(`Skipped ${objFullName}.${applyNamespace(f.apiName, namespaceReplacement)}: referenced object ${refTo} not in migration`, {
                object: objFullName,
                field: `${objFullName}.${applyNamespace(f.apiName, namespaceReplacement)}`,
                skipped: true,
                reason: 'referenced_object_not_in_migration',
              });
              continue;
            }
            const meta = buildFieldMetadata(f, objFullName, namespaceReplacement);
            if (!meta) continue;

            sendProgress(`Creating field ${meta.fullName}...`, {
              object: objFullName,
              field: meta.fullName,
            });

            try {
              const fieldResult = await conn.metadata.create('CustomField', meta);
              const fieldResults = Array.isArray(fieldResult) ? fieldResult : [fieldResult];
              const fieldFailed = fieldResults.find((r) => r && r.success === false);
              if (fieldFailed && (fieldFailed.errors?.length || fieldFailed.fullName)) {
                const errMsg = (fieldFailed.errors || []).map((e) => e.message || e.statusCode || String(e)).join('; ') || `Create failed for ${fieldFailed.fullName || meta.fullName}`;
                throw new Error(errMsg);
              }
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
        } else if (om.objectAction === 'map' && tgt) {
          const objFullName = tgt.apiName;
          const fieldsToCreate = (om.fieldMappings || []).filter(
            (fm) => fm.action === 'create' && fm.source
          );

          for (const fm of fieldsToCreate) {
            const src = fm.source;
            if (shouldSkipLookupField(src, objectsBeingCreated, namespaceReplacement)) {
              const refTo = applyNamespace(src.referenceTo?.[0], namespaceReplacement);
              advanceProgress(`Skipped ${objFullName}.${applyNamespace(src.apiName, namespaceReplacement)}: referenced object ${refTo} not in migration`, {
                object: objFullName,
                field: `${objFullName}.${applyNamespace(src.apiName, namespaceReplacement)}`,
                skipped: true,
                reason: 'referenced_object_not_in_migration',
              });
              continue;
            }
            const meta = buildFieldMetadata(src, objFullName, namespaceReplacement);
            if (!meta) continue;

            sendProgress(`Creating field ${meta.fullName}...`, {
              object: objFullName,
              field: meta.fullName,
            });

            try {
              const createResult = await conn.metadata.create('CustomField', meta);
              const results = Array.isArray(createResult) ? createResult : [createResult];
              const failed = results.find((r) => r && r.success === false);
              if (failed && (failed.errors?.length || failed.fullName)) {
                const errMsg = (failed.errors || []).map((e) => e.message || e.statusCode || String(e)).join('; ') || `Create failed for ${failed.fullName || meta.fullName}`;
                throw new Error(errMsg);
              }
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
