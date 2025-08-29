// migration-scripts/run-schema-generation.js
const DynamicSchemaGenerator = require("./dynamic-schema-generator");
const path = require("path");
const fs = require("fs-extra");

async function runMigration() {
  console.log("🚀 Starting Sanity to Strapi Schema Migration");
  console.log("=".repeat(50));

  try {
    // Configuration - update these paths for your setup
    const config = {
      sanityProjectPath: "../../studio-first-project", // Path to your Sanity studio project
      exportedDataPath: "../sanity-export", // Path to your exported Sanity data
      strapiProjectPath: "../strapi-project", // Path to your Strapi project
    };

    // Validate paths
    if (!fs.existsSync(config.sanityProjectPath)) {
      throw new Error(
        `Sanity project path not found: ${config.sanityProjectPath}`
      );
    }

    if (!fs.existsSync(config.exportedDataPath)) {
      throw new Error(
        `Exported data path not found: ${config.exportedDataPath}`
      );
    }

    if (!fs.existsSync(config.strapiProjectPath)) {
      throw new Error(
        `Strapi project path not found: ${config.strapiProjectPath}`
      );
    }

    console.log("✅ Configuration validated");
    console.log(`Sanity project: ${config.sanityProjectPath}`);
    console.log(`Exported data: ${config.exportedDataPath}`);
    console.log(`Strapi project: ${config.strapiProjectPath}`);
    console.log("");

    // Initialize generator
    const generator = new DynamicSchemaGenerator();

    // Run the migration
    await generator.generateFromSanityProject(
      config.sanityProjectPath,
      config.exportedDataPath
    );

    console.log("");
    console.log("🎉 Migration completed successfully!");
    console.log("");
    console.log("Next steps:");
    console.log("1. Review the generated schemas in your Strapi project");
    console.log("2. Check the schema-generation-report.json for details");
    console.log(
      "3. Start your Strapi server: cd strapi-project && npm run develop"
    );
    console.log(
      "4. Review and adjust the generated content types in the Strapi admin"
    );
    console.log("5. Run the data migration script (coming next!)");
  } catch (error) {
    console.error("❌ Migration failed:", error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  runMigration();
}

module.exports = { runMigration };
