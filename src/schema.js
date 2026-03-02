const express = require('express');
const { getConnection, requireAuth } = require('./auth');

const router = express.Router();
const VALID_ORG_TYPES = ['source', 'target'];
const BATCH_SIZE = 10;

/**
 * Extract namespace from API name.
 * "MaicaCare__Client__c" -> "MaicaCare"
 * "Custom_Risk_Level__c" -> null
 */
function getNamespace(apiName) {
  if (!apiName || typeof apiName !== 'string') return null;
  const parts = apiName.split('__');
  if (parts.length === 3 && ['c', 'r', 'f'].includes(parts[2])) {
    return parts[0];
  }
  return null;
}

function mapField(field) {
  const picklistValues =
    field.type === 'picklist' || field.type === 'multipicklist'
      ? (field.picklistValues || []).map((p) => ({
          value: p.value,
          label: p.label ?? p.value,
          active: p.active,
        }))
      : undefined;

  return {
    apiName: field.name,
    label: field.label,
    type: field.type,
    length: field.length,
    precision: field.precision,
    scale: field.scale,
    referenceTo: field.referenceTo?.length ? field.referenceTo : undefined,
    required: !field.nillable && !field.defaultedOnCreate,
    unique: field.unique,
    externalId: field.externalId ?? undefined,
    picklistValues,
    formula: field.calculatedFormula ?? undefined,
    defaultValue: field.defaultValue ?? field.defaultValueFormula ?? undefined,
    helpText: field.inlineHelpText ?? undefined,
    package: getNamespace(field.name),
  };
}

function mapChildRelationship(cr) {
  if (!cr.childSObject || !cr.field) return null;
  return {
    childObject: cr.childSObject,
    field: cr.field,
    relationshipName: cr.relationshipName ?? undefined,
  };
}

router.get(
  '/:orgType/schema',
  (req, res, next) => {
    const { orgType } = req.params;
    if (!VALID_ORG_TYPES.includes(orgType)) {
      return res.status(400).json({ error: 'orgType must be "source" or "target"' });
    }
    req.orgType = orgType;
    next();
  },
  (req, res, next) => requireAuth(req.orgType)(req, res, next),
  async (req, res) => {
    const { orgType } = req;
    const conn = getConnection(req, orgType);
    if (!conn) {
      return res.status(401).json({ error: `Not connected to ${orgType} org` });
    }

    try {
      const globalResult = await conn.describeGlobal();
      const customObjects = (globalResult.sobjects || []).filter(
        (obj) => obj.custom === true && obj.queryable === true
      );
      const objectNames = customObjects.map((obj) => obj.name);

      const objects = [];
      for (let i = 0; i < objectNames.length; i += BATCH_SIZE) {
        const batch = objectNames.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(
          batch.map(async (name) => {
            try {
              return await conn.describe(name);
            } catch {
              return null;
            }
          })
        );

        for (let j = 0; j < batch.length; j++) {
          const desc = results[j];
          if (!desc) continue;

          const customFields = (desc.fields || [])
            .filter((f) => f.custom === true)
            .map(mapField);

          const childRelationships = (desc.childRelationships || [])
            .map(mapChildRelationship)
            .filter(Boolean);

          objects.push({
            apiName: desc.name,
            label: desc.label,
            labelPlural: desc.labelPlural,
            package: getNamespace(desc.name),
            keyPrefix: desc.keyPrefix ?? undefined,
            fields: customFields,
            childRelationships,
          });
        }
      }

      res.json({
        orgType,
        objectCount: objects.length,
        objects,
      });
    } catch (err) {
      console.error('Schema discovery error:', err);
      res.status(500).json({
        error: err.message || 'Schema discovery failed',
      });
    }
  }
);

module.exports = router;
