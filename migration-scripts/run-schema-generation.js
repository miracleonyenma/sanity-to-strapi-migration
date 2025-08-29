// migration-scripts/run-schema-generation.js
const fs = require("fs-extra");
const path = require("path");
const DynamicSchemaGenerator = require("./dynamic-schema-generator");

async function runSchemaGeneration() {
  console.log("🔄 Starting Dynamic Schema Generation");
  console.log("====================================\n");

  // Check prerequisites
  const checks = await performPrerequisiteChecks();
  if (!checks.allPassed) {
    console.log(
      "❌ Prerequisites not met. Please resolve the above issues and try again."
    );
    return;
  }

  // Initialize generator
  const generator = new DynamicSchemaGenerator();

  try {
    // Find export file
    const exportFile = findExportFile();
    console.log(`📄 Using export file: ${exportFile}`);

    // Find analysis file (optional)
    const analysisFile = findAnalysisFile();
    if (analysisFile) {
      console.log(`📊 Using analysis file: ${analysisFile}`);
    }

    // Generate schemas
    await generator.generateFromExport(exportFile, analysisFile);

    // Generate report
    await generator.generateMigrationReport();

    // Show summary
    await showGenerationSummary();

    console.log("\n🎉 Schema generation completed successfully!");
    console.log("\nNext steps:");
    console.log(
      "1. Review the generated schemas in ../strapi-project/src/api/"
    );
    console.log("2. Check the migration report: schema-generation-report.json");
    console.log(
      "3. Start your Strapi server: cd ../strapi-project && npm run develop"
    );
    console.log("4. Verify the content types appear in the Strapi admin");
  } catch (error) {
    console.error("❌ Schema generation failed:", error.message);
    console.error("Full error:", error);
  }
}

async function performPrerequisiteChecks() {
  console.log("🔍 Checking prerequisites...");

  const checks = {
    exportExists: false,
    strapiProjectExists: false,
    allPassed: false,
  };

  // Check for export file
  const exportFiles = [
    "../sanity-export/full-export.ndjson",
    "../sanity-export/data.ndjson",
    "../sanity-export/export.ndjson",
  ];

  for (const file of exportFiles) {
    if (await fs.pathExists(file)) {
      checks.exportExists = file;
      console.log(`✅ Found export file: ${file}`);
      break;
    }
  }

  if (!checks.exportExists) {
    console.log("❌ No export file found. Please run Sanity export first:");
    console.log("   cd your-sanity-project");
    console.log(
      "   sanity dataset export production ../sanity-to-strapi-migration/sanity-export/full-export.ndjson"
    );
  }

  // Check for Strapi project
  const strapiProjectPath = "../strapi-project";
  if (await fs.pathExists(path.join(strapiProjectPath, "package.json"))) {
    checks.strapiProjectExists = true;
    console.log("✅ Strapi project found");
  } else {
    console.log("❌ Strapi project not found. Please create it first:");
    console.log("   npx create-strapi-app@latest strapi-project --quickstart");
  }

  // Check if Strapi API directory exists
  const apiDir = path.join(strapiProjectPath, "src", "api");
  if (await fs.pathExists(apiDir)) {
    console.log("✅ Strapi API directory ready");
  } else {
    if (checks.strapiProjectExists) {
      console.log("⚠️  Creating Strapi API directory...");
      await fs.ensureDir(apiDir);
    }
  }

  // Check if components directory exists
  const componentsDir = path.join(strapiProjectPath, "src", "components");
  if (checks.strapiProjectExists) {
    await fs.ensureDir(componentsDir);
    console.log("✅ Strapi components directory ready");
  }

  checks.allPassed = checks.exportExists && checks.strapiProjectExists;

  if (checks.allPassed) {
    console.log("✅ All prerequisites met\n");
  } else {
    console.log("❌ Some prerequisites missing\n");
  }

  return checks;
}

function findExportFile() {
  const possibleFiles = [
    "../sanity-export/full-export.ndjson",
    "../sanity-export/data.ndjson",
    "../sanity-export/export.ndjson",
  ];

  for (const file of possibleFiles) {
    if (fs.existsSync(file)) {
      return file;
    }
  }

  throw new Error("No export file found");
}

function findAnalysisFile() {
  const possibleFiles = [
    "./export-analysis.json",
    "../migration-scripts/export-analysis.json",
  ];

  for (const file of possibleFiles) {
    if (fs.existsSync(file)) {
      return file;
    }
  }

  return null;
}

async function showGenerationSummary() {
  try {
    const reportPath = "./schema-generation-report.json";
    if (await fs.pathExists(reportPath)) {
      const report = await fs.readJSON(reportPath);

      console.log("\n📊 Generation Summary:");
      console.log("=====================");
      console.log(`Document types: ${report.summary.totalDocumentTypes}`);
      console.log(`Components: ${report.summary.totalComponents}`);
      console.log(`Fields mapped: ${report.summary.fieldsMapped}`);

      console.log("\nDocument Types Generated:");
      Object.keys(report.documentTypes).forEach((type) => {
        const info = report.documentTypes[type];
        console.log(`  - ${type} (${info.fieldCount} fields)`);
      });

      if (report.summary.totalComponents > 0) {
        console.log("\nComponents Generated:");
        Object.keys(report.components).forEach((comp) => {
          console.log(`  - ${comp}`);
        });
      }
    }
  } catch (error) {
    console.log("Could not load generation summary");
  }
}

// Interactive mode
async function interactiveMode() {
  const readline = require("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  function question(prompt) {
    return new Promise((resolve) => rl.question(prompt, resolve));
  }

  try {
    console.log("🤖 Dynamic Schema Generator - Interactive Mode");
    console.log("==============================================\n");

    const hasExport = await question(
      "Do you have a Sanity export file ready? (y/n): "
    );
    if (hasExport.toLowerCase() !== "y") {
      console.log("\nPlease export your Sanity data first:");
      console.log("1. cd your-sanity-project");
      console.log(
        "2. sanity dataset export production ../sanity-to-strapi-migration/sanity-export/full-export.ndjson"
      );
      console.log("3. Run this script again");
      rl.close();
      return;
    }

    const hasStrapi = await question(
      "Do you have a Strapi project set up? (y/n): "
    );
    if (hasStrapi.toLowerCase() !== "y") {
      console.log("\nPlease create a Strapi project first:");
      console.log(
        "1. npx create-strapi-app@latest strapi-project --quickstart"
      );
      console.log("2. Run this script again");
      rl.close();
      return;
    }

    const proceed = await question(
      "Ready to generate schemas? This will create/overwrite schema files. (y/n): "
    );
    if (proceed.toLowerCase() === "y") {
      rl.close();
      await runSchemaGeneration();
    } else {
      console.log("Schema generation cancelled.");
      rl.close();
    }
  } catch (error) {
    console.error("Interactive mode error:", error);
    rl.close();
  }
}

// CLI argument handling
const args = process.argv.slice(2);

if (args.includes("--interactive") || args.includes("-i")) {
  interactiveMode();
} else if (args.includes("--help") || args.includes("-h")) {
  console.log("Dynamic Schema Generator Usage:");
  console.log("===============================");
  console.log("");
  console.log("node run-schema-generation.js [options]");
  console.log("");
  console.log("Options:");
  console.log("  --interactive, -i    Run in interactive mode");
  console.log("  --help, -h           Show this help message");
  console.log("");
  console.log("Prerequisites:");
  console.log("  1. Sanity export file at ../sanity-export/full-export.ndjson");
  console.log("  2. Strapi project at ../strapi-project");
  console.log("");
  console.log("The generator will:");
  console.log("  - Analyze your Sanity export data");
  console.log("  - Generate appropriate Strapi schemas");
  console.log("  - Create components for nested objects");
  console.log("  - Provide a detailed migration report");
} else {
  runSchemaGeneration();
}

module.exports = {
  runSchemaGeneration,
  performPrerequisiteChecks,
};
