// migration-scripts/analyze-export.js
const fs = require("fs");
const readline = require("readline");

async function analyzeExport() {
  const fileStream = fs.createReadStream(
    "../sanity-export/production-export-2025-08-28t13-56-35-457z/data.ndjson"
  );
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  const typeCount = {};
  const sampleDocs = {};

  for await (const line of rl) {
    const doc = JSON.parse(line);

    // Count document types
    typeCount[doc._type] = (typeCount[doc._type] || 0) + 1;

    // Store samples for our known types
    if (["post", "person", "category", "page", "product"].includes(doc._type)) {
      if (!sampleDocs[doc._type]) {
        sampleDocs[doc._type] = doc;
      }
    }
  }

  console.log("Document type counts:", typeCount);

  // Save analysis results
  fs.writeFileSync(
    "export-analysis.json",
    JSON.stringify(
      {
        typeCount,
        sampleDocs,
      },
      null,
      2
    )
  );
}

analyzeExport();
