const express = require('express');
const router = express.Router();

// Regex patterns for Salesforce API name references
const PATTERNS = [
  // Namespaced custom: MaicaCare__Client__c, MaicaCare__Client__r
  /[A-Za-z_]+__[A-Za-z_]+__[crf]/g,
  // Unmanaged custom: Custom_Field__c (not part of a namespaced reference)
  /(?<![A-Za-z_])[A-Z][A-Za-z0-9_]*__[crf]/g,
  // Relationship references: MaicaCare__Client__r (covered by first, but explicit for __r)
  /[A-Za-z_]+__[A-Za-z_]+__r/g,
];

/**
 * Scans body text for Salesforce API name references.
 * @param {string} body - Apex/code string to scan
 * @returns {string[]} Unique sorted references
 */
function analyzeReferences(body) {
  if (!body || typeof body !== 'string') return [];

  const seen = new Set();
  for (const re of PATTERNS) {
    const matches = body.matchAll(re);
    for (const m of matches) {
      if (m[0]) seen.add(m[0]);
    }
  }
  return [...seen].sort();
}

router.post('/analyze-references', express.json(), (req, res) => {
  const body = req.body?.body;
  if (body === undefined || body === null) {
    return res.status(400).json({ error: 'Missing body.body in request' });
  }
  const references = analyzeReferences(String(body));
  res.json({ references });
});

// Keep legacy GET /references stub for backwards compatibility
router.get('/references', (req, res) => {
  res.json({ message: 'Use POST /api/analyze-references with { body: "code" }' });
});

module.exports = router;
module.exports.analyzeReferences = analyzeReferences;
