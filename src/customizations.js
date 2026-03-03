const express = require('express');
const { getConnection, requireAuth } = require('./auth');

const router = express.Router();
const VALID_ORG_TYPES = ['source', 'target'];

function countLines(str) {
  if (!str || typeof str !== 'string') return 0;
  return str.split(/\r?\n/).length;
}

router.get(
  '/:orgType/customizations',
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

    const raw = {
      apexClasses: [],
      apexTriggers: [],
      lwcComponents: [],
      auraComponents: [],
      customLabels: [],
      permissionSets: [],
      layouts: [],
      flows: [],
      validationRules: [],
      reports: [],
    };

    const customizations = [];

    // 1. Apex Classes
    try {
      const r = await conn.tooling.query(
        'SELECT Id, Name, Body, NamespacePrefix, CreatedDate, LastModifiedDate, LengthWithoutComments FROM ApexClass WHERE NamespacePrefix = null ORDER BY Name'
      );
      raw.apexClasses = r.records || [];
      for (const rec of raw.apexClasses) {
        customizations.push({
          id: rec.Id,
          name: rec.Name,
          type: 'ApexClass',
          category: 'Apex',
          body: rec.Body || '',
          lineCount: countLines(rec.Body),
          size: rec.LengthWithoutComments ?? (rec.Body?.length ?? 0),
          lastModified: rec.LastModifiedDate,
        });
      }
    } catch (err) {
      console.warn('ApexClass query failed:', err.message);
    }

    // 2. Apex Triggers
    try {
      const r = await conn.tooling.query(
        'SELECT Id, Name, Body, TableEnumOrId, NamespacePrefix, LastModifiedDate FROM ApexTrigger WHERE NamespacePrefix = null ORDER BY Name'
      );
      raw.apexTriggers = r.records || [];
      for (const rec of raw.apexTriggers) {
        customizations.push({
          id: rec.Id,
          name: rec.Name,
          type: 'ApexTrigger',
          category: 'Apex',
          body: rec.Body || '',
          targetObject: rec.TableEnumOrId,
          lineCount: countLines(rec.Body),
          lastModified: rec.LastModifiedDate,
        });
      }
    } catch (err) {
      console.warn('ApexTrigger query failed:', err.message);
    }

    // 3. LWC Components
    try {
      const r = await conn.tooling.query(
        'SELECT Id, DeveloperName, MasterLabel, NamespacePrefix, LastModifiedDate FROM LightningComponentBundle WHERE NamespacePrefix = null ORDER BY DeveloperName'
      );
      raw.lwcComponents = r.records || [];
      for (const rec of raw.lwcComponents) {
        customizations.push({
          id: rec.Id,
          name: rec.DeveloperName,
          label: rec.MasterLabel,
          type: 'LightningComponentBundle',
          category: 'LWC',
          lastModified: rec.LastModifiedDate,
        });
      }
    } catch (err) {
      console.warn('LightningComponentBundle query failed:', err.message);
    }

    // 4. Aura Components
    try {
      const r = await conn.tooling.query(
        'SELECT Id, DeveloperName, MasterLabel, NamespacePrefix, LastModifiedDate FROM AuraDefinitionBundle WHERE NamespacePrefix = null ORDER BY DeveloperName'
      );
      raw.auraComponents = r.records || [];
      for (const rec of raw.auraComponents) {
        customizations.push({
          id: rec.Id,
          name: rec.DeveloperName,
          label: rec.MasterLabel,
          type: 'AuraDefinitionBundle',
          category: 'Aura',
          lastModified: rec.LastModifiedDate,
        });
      }
    } catch (err) {
      console.warn('AuraDefinitionBundle query failed:', err.message);
    }

    // 5. Custom Labels
    try {
      const r = await conn.tooling.query(
        'SELECT Id, Name, Value, NamespacePrefix, LastModifiedDate FROM ExternalString WHERE NamespacePrefix = null ORDER BY Name'
      );
      raw.customLabels = r.records || [];
      for (const rec of raw.customLabels) {
        customizations.push({
          id: rec.Id,
          name: rec.Name,
          type: 'CustomLabel',
          category: 'Custom Labels',
          value: rec.Value,
          lastModified: rec.LastModifiedDate,
        });
      }
    } catch (err) {
      console.warn('ExternalString query failed:', err.message);
    }

    // 6. Permission Sets (custom, unmanaged)
    try {
      const r = await conn.query(
        'SELECT Id, Name, Label, IsCustom, NamespacePrefix, LastModifiedDate FROM PermissionSet WHERE IsCustom = true AND NamespacePrefix = null ORDER BY Label'
      );
      raw.permissionSets = r.records || [];
      for (const rec of raw.permissionSets) {
        customizations.push({
          id: rec.Id,
          name: rec.Name,
          label: rec.Label,
          type: 'PermissionSet',
          category: 'Permissions',
          lastModified: rec.LastModifiedDate,
        });
      }
    } catch (err) {
      console.warn('PermissionSet query failed:', err.message);
    }

    // 7. Page Layouts (unmanaged)
    try {
      const r = await conn.tooling.query(
        'SELECT Id, Name, EntityDefinition.QualifiedApiName, NamespacePrefix, LastModifiedDate FROM Layout WHERE NamespacePrefix = null ORDER BY Name'
      );
      raw.layouts = r.records || [];
      for (const rec of raw.layouts) {
        const targetObject = rec.EntityDefinition?.QualifiedApiName ?? rec.EntityDefinition?.DeveloperName ?? null;
        customizations.push({
          id: rec.Id,
          name: rec.Name,
          type: 'Layout',
          category: 'Layouts',
          targetObject,
          lastModified: rec.LastModifiedDate,
        });
      }
    } catch (err) {
      console.warn('Layout query failed:', err.message);
    }

    // 8. Flows (Active only, unmanaged)
    try {
      const r = await conn.tooling.query(
        "SELECT Id, DeveloperName, MasterLabel, ProcessType, Status, LastModifiedDate FROM Flow WHERE Status = 'Active' AND ProcessType IN ('AutoLaunchedFlow', 'Flow', 'Workflow') AND NamespacePrefix = null ORDER BY MasterLabel"
      );
      raw.flows = r.records || [];
      for (const rec of raw.flows) {
        customizations.push({
          id: rec.Id,
          name: rec.DeveloperName,
          label: rec.MasterLabel,
          type: 'Flow',
          category: 'Flow',
          processType: rec.ProcessType,
          lastModified: rec.LastModifiedDate,
        });
      }
    } catch (err) {
      console.warn('Flow query failed:', err.message);
    }

    // 9. Validation Rules (Active only, unmanaged objects only)
    try {
      const r = await conn.tooling.query(
        "SELECT Id, ValidationName, EntityDefinition.QualifiedApiName, Active, ErrorConditionFormula, ErrorMessage, LastModifiedDate FROM ValidationRule WHERE Active = true AND EntityDefinition.NamespacePrefix = null ORDER BY ValidationName"
      );
      raw.validationRules = r.records || [];
      for (const rec of raw.validationRules) {
        const targetObject = rec.EntityDefinition?.QualifiedApiName ?? rec.EntityDefinition?.DeveloperName ?? null;
        const metadata = rec.Metadata;
        const formula = rec.ErrorConditionFormula ?? metadata?.errorConditionFormula ?? metadata?.formula ?? null;
        const errorMessage = rec.ErrorMessage ?? metadata?.errorMessage ?? null;
        customizations.push({
          id: rec.Id,
          name: rec.ValidationName,
          type: 'ValidationRule',
          category: 'Validation',
          targetObject,
          formula,
          errorMessage,
          lastModified: rec.LastModifiedDate,
        });
      }
    } catch (err) {
      console.warn('ValidationRule query failed:', err.message);
    }

    // 10. Reports
    try {
      const r = await conn.query(
        'SELECT Id, Name, DeveloperName, Folder.Name, LastModifiedDate FROM Report WHERE IsDeleted = false ORDER BY Name LIMIT 200'
      );
      raw.reports = r.records || [];
      for (const rec of raw.reports) {
        customizations.push({
          id: rec.Id,
          name: rec.Name,
          developerName: rec.DeveloperName,
          type: 'Report',
          category: 'Report',
          folder: rec.Folder?.Name ?? null,
          lastModified: rec.LastModifiedDate,
        });
      }
    } catch (err) {
      console.warn('Report query failed:', err.message);
    }

    const byCategory = {
      apex: raw.apexClasses.length + raw.apexTriggers.length,
      lwc: raw.lwcComponents.length,
      aura: raw.auraComponents.length,
      customLabels: raw.customLabels.length,
      permissions: raw.permissionSets.length,
      layouts: raw.layouts.length,
      flows: raw.flows.length,
      validationRules: raw.validationRules.length,
      reports: raw.reports.length,
    };

    res.json({
      orgType,
      totalCount: customizations.length,
      byCategory,
      customizations,
      raw,
    });
  }
);

module.exports = router;
