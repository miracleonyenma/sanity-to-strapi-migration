// migration-scripts/dynamic-schema-generator.js
const fs = require("fs-extra");
const path = require("path");

class DynamicSchemaGenerator {
  constructor() {
    // Field type mappings from Sanity to Strapi
    this.typeMapping = {
      string: "string",
      text: "text",
      number: "decimal",
      boolean: "boolean",
      datetime: "datetime",
      date: "date",
      email: "email",
      url: "string",
      slug: "uid",
      image: "media",
      file: "media",
      geopoint: "json",
      color: "string",
    };

    this.componentsToCreate = new Map();
    this.relationshipsToCreate = [];
    this.processedSchemas = new Map();
  }

  // Main entry point - can work with either approach
  async generateFromSanitySchemas(schemasPath, exportAnalysisPath = null) {
    console.log("🔄 Analyzing Sanity schemas...");

    let sanitySchemas = [];
    let sampleData = null;

    // Try to load schema files directly
    if (fs.existsSync(schemasPath)) {
      if (schemasPath.endsWith(".js") || schemasPath.endsWith(".ts")) {
        // Single schema file
        const schemaModule = require(path.resolve(schemasPath));
        sanitySchemas = schemaModule.schemaTypes ||
          schemaModule.default || [schemaModule];
      } else {
        // Directory of schema files
        const schemaFiles = fs
          .readdirSync(schemasPath)
          .filter((file) => file.endsWith(".ts") || file.endsWith(".js"))
          .filter((file) => !file.includes("index"));

        for (const file of schemaFiles) {
          try {
            const schemaPath = path.join(schemasPath, file);
            const schemaModule = require(path.resolve(schemaPath));
            const schema = schemaModule.default || schemaModule;
            if (schema && schema.name) {
              sanitySchemas.push(schema);
            }
          } catch (error) {
            console.warn(
              `⚠️  Could not load schema from ${file}:`,
              error.message
            );
          }
        }
      }
    }

    // Load sample data if available
    if (exportAnalysisPath && fs.existsSync(exportAnalysisPath)) {
      const analysisData = JSON.parse(
        fs.readFileSync(exportAnalysisPath, "utf8")
      );
      sampleData = analysisData.sampleDocs;
    }

    if (sanitySchemas.length === 0) {
      throw new Error(
        "No Sanity schemas found. Please check your schema path."
      );
    }

    console.log(`📋 Found ${sanitySchemas.length} schema types to convert`);

    // Analyze schemas and generate Strapi equivalents
    for (const schema of sanitySchemas) {
      await this.convertSchema(schema, sampleData);
    }

    // Create components first
    await this.generateComponents();

    // Then create the main schemas
    await this.generateSchemas();

    console.log("✅ Schema generation complete!");
    this.printSummary();
  }

  convertSchema(sanitySchema, sampleData = null) {
    if (sanitySchema.type !== "document") {
      console.log(`ℹ️  Skipping non-document schema: ${sanitySchema.name}`);
      return;
    }

    console.log(`🔄 Converting schema: ${sanitySchema.name}`);

    const strapiSchema = {
      kind: "collectionType",
      collectionName: this.pluralize(sanitySchema.name),
      info: {
        singularName: sanitySchema.name,
        pluralName: this.pluralize(sanitySchema.name),
        displayName: sanitySchema.title || sanitySchema.name,
      },
      options: {
        draftAndPublish: true,
      },
      pluginOptions: {},
      attributes: {},
    };

    // Add standard Strapi fields
    if (this.hasPublishDate(sanitySchema)) {
      strapiSchema.attributes.publishedAt = {
        type: "datetime",
      };
    }

    // Convert fields
    if (sanitySchema.fields) {
      for (const field of sanitySchema.fields) {
        const convertedField = this.convertField(
          field,
          sanitySchema.name,
          sampleData
        );
        if (convertedField) {
          strapiSchema.attributes[field.name] = convertedField;
        }
      }
    }

    this.processedSchemas.set(sanitySchema.name, strapiSchema);
  }

  convertField(field, parentSchemaName, sampleData = null) {
    const fieldType = field.type;
    let strapiField = null;

    // Handle validation and options
    const hasValidation =
      field.validation && typeof field.validation === "function";
    const hasRequired = hasValidation; // We'll assume validation means required for now
    const options = field.options || {};

    switch (fieldType) {
      case "string":
        strapiField = {
          type: "string",
        };
        if (hasRequired) strapiField.required = true;
        break;

      case "text":
        strapiField = {
          type: "text",
        };
        if (hasRequired) strapiField.required = true;
        break;

      case "number":
        strapiField = {
          type: field.name.toLowerCase().includes("price")
            ? "decimal"
            : "integer",
        };
        if (hasRequired) strapiField.required = true;
        if (options.min !== undefined) strapiField.min = options.min;
        if (options.max !== undefined) strapiField.max = options.max;
        break;

      case "boolean":
        strapiField = {
          type: "boolean",
        };
        if (field.initialValue !== undefined) {
          strapiField.default = field.initialValue;
        }
        break;

      case "datetime":
      case "date":
        strapiField = {
          type: fieldType,
        };
        if (hasRequired) strapiField.required = true;
        break;

      case "slug":
        strapiField = {
          type: "uid",
        };
        if (options.source) {
          strapiField.targetField = options.source;
        }
        if (hasRequired) strapiField.required = true;
        break;

      case "image":
      case "file":
        strapiField = {
          type: "media",
          multiple: false,
          allowedTypes: fieldType === "image" ? ["images"] : ["files"],
        };
        break;

      case "url":
        strapiField = {
          type: "string",
        };
        break;

      case "email":
        strapiField = {
          type: "email",
        };
        break;

      case "array":
        strapiField = this.handleArrayField(
          field,
          parentSchemaName,
          sampleData
        );
        break;

      case "reference":
        strapiField = this.handleReferenceField(field, parentSchemaName);
        break;

      case "object":
        strapiField = this.handleObjectField(field, parentSchemaName);
        break;

      default:
        console.warn(
          `⚠️  Unhandled field type: ${fieldType} for field ${field.name}`
        );
        strapiField = {
          type: "json",
          _note: `Original type: ${fieldType}`,
        };
    }

    return strapiField;
  }

  handleArrayField(field, parentSchemaName, sampleData = null) {
    if (!field.of || field.of.length === 0) {
      return {
        type: "json",
        _note: "Empty array field",
      };
    }

    const arrayItemType = field.of[0];

    switch (arrayItemType.type) {
      case "reference":
        // Array of references -> many-to-many relation
        const targetType = arrayItemType.to[0].type;
        return {
          type: "relation",
          relation: "manyToMany",
          target: `api::${targetType}.${targetType}`,
        };

      case "string":
        // Array of strings -> component with repeatable string
        const componentName = `${parentSchemaName}-${field.name}`;
        this.componentsToCreate.set(componentName, {
          collectionName: `components_${parentSchemaName}_${field.name}`,
          info: {
            displayName: field.title || field.name,
          },
          options: {},
          attributes: {
            value: {
              type: "string",
            },
          },
        });

        return {
          type: "component",
          repeatable: true,
          component: `${parentSchemaName}.${field.name}`,
        };

      case "image":
      case "file":
        // Array of images/files -> media field with multiple
        return {
          type: "media",
          multiple: true,
          allowedTypes: arrayItemType.type === "image" ? ["images"] : ["files"],
        };

      case "block":
        // Rich text blocks
        return {
          type: "richtext",
        };

      case "object":
        // Array of objects -> repeatable component
        const objComponentName = `${parentSchemaName}-${field.name}`;
        const componentAttributes = {};

        if (arrayItemType.fields) {
          for (const objField of arrayItemType.fields) {
            const convertedField = this.convertField(
              objField,
              parentSchemaName
            );
            if (convertedField) {
              componentAttributes[objField.name] = convertedField;
            }
          }
        }

        this.componentsToCreate.set(objComponentName, {
          collectionName: `components_${parentSchemaName}_${field.name}`,
          info: {
            displayName: field.title || field.name,
          },
          options: {},
          attributes: componentAttributes,
        });

        return {
          type: "component",
          repeatable: true,
          component: `${parentSchemaName}.${field.name}`,
        };

      default:
        return {
          type: "json",
          _note: `Array of ${arrayItemType.type}`,
        };
    }
  }

  handleReferenceField(field, parentSchemaName) {
    if (!field.to || field.to.length === 0) {
      return {
        type: "json",
        _note: "Reference without target",
      };
    }

    const targetType = field.to[0].type;
    return {
      type: "relation",
      relation: "manyToOne",
      target: `api::${targetType}.${targetType}`,
    };
  }

  handleObjectField(field, parentSchemaName) {
    const componentName = `${parentSchemaName}-${field.name}`;
    const componentAttributes = {};

    if (field.fields) {
      for (const objField of field.fields) {
        const convertedField = this.convertField(objField, parentSchemaName);
        if (convertedField) {
          componentAttributes[objField.name] = convertedField;
        }
      }
    }

    // Create component
    this.componentsToCreate.set(componentName, {
      collectionName: `components_${parentSchemaName}_${field.name}`,
      info: {
        displayName: field.title || field.name,
      },
      options: {},
      attributes: componentAttributes,
    });

    return {
      type: "component",
      repeatable: false,
      component: `${parentSchemaName}.${field.name}`,
    };
  }

  async generateComponents() {
    console.log(`🔧 Generating ${this.componentsToCreate.size} components...`);

    for (const [componentName, componentSchema] of this.componentsToCreate) {
      const [namespace, name] = componentName.split("-");
      const componentDir = `../strapi-project/src/components/${namespace}`;

      await fs.ensureDir(componentDir);
      await fs.writeJSON(`${componentDir}/${name}.json`, componentSchema, {
        spaces: 2,
      });

      console.log(`  ✅ Generated component: ${namespace}.${name}`);
    }
  }

  async generateSchemas() {
    console.log(
      `📝 Generating ${this.processedSchemas.size} collection schemas...`
    );

    for (const [schemaName, strapiSchema] of this.processedSchemas) {
      const schemaDir = `../strapi-project/src/api/${schemaName}/content-types/${schemaName}`;
      await fs.ensureDir(schemaDir);
      await fs.writeJSON(`${schemaDir}/schema.json`, strapiSchema, {
        spaces: 2,
      });

      // Generate controller, service, and routes
      await this.generateApiFiles(schemaName);

      console.log(`  ✅ Generated schema: ${schemaName}`);
    }
  }

  async generateApiFiles(schemaName) {
    const apiDir = `../strapi-project/src/api/${schemaName}`;

    // Controller
    const controllerContent = `/**
 * ${schemaName} controller
 */

import { factories } from '@strapi/strapi'

export default factories.createCoreController('api::${schemaName}.${schemaName}');
`;

    // Service
    const serviceContent = `/**
 * ${schemaName} service
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreService('api::${schemaName}.${schemaName}');
`;

    // Routes
    const routeContent = `/**
 * ${schemaName} router
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::${schemaName}.${schemaName}');
`;

    await fs.ensureDir(`${apiDir}/controllers`);
    await fs.ensureDir(`${apiDir}/services`);
    await fs.ensureDir(`${apiDir}/routes`);

    await fs.writeFile(
      `${apiDir}/controllers/${schemaName}.ts`,
      controllerContent
    );
    await fs.writeFile(`${apiDir}/services/${schemaName}.ts`, serviceContent);
    await fs.writeFile(`${apiDir}/routes/${schemaName}.ts`, routeContent);
  }

  printSummary() {
    console.log("\n📊 SCHEMA CONVERSION SUMMARY");
    console.log("================================");
    console.log(`Collection Types: ${this.processedSchemas.size}`);
    console.log(`Components: ${this.componentsToCreate.size}`);

    console.log("\n📋 Generated Collection Types:");
    for (const [name] of this.processedSchemas) {
      console.log(`  - ${name}`);
    }

    console.log("\n🔧 Generated Components:");
    for (const [name] of this.componentsToCreate) {
      const [namespace, componentName] = name.split("-");
      console.log(`  - ${namespace}.${componentName}`);
    }

    console.log("\n⚠️  IMPORTANT NOTES:");
    console.log("- Review generated schemas for any manual adjustments needed");
    console.log("- Some complex Sanity field types may need manual refinement");
    console.log("- Restart your Strapi server to see the new schemas");
    console.log(
      "- Test the admin interface to ensure everything works as expected"
    );
  }

  // Helper methods
  pluralize(word) {
    const plurals = {
      person: "people",
      category: "categories",
      company: "companies",
      story: "stories",
    };

    if (plurals[word]) return plurals[word];
    if (word.endsWith("y")) return word.slice(0, -1) + "ies";
    if (word.endsWith("s")) return word + "es";
    return word + "s";
  }

  hasPublishDate(schema) {
    if (!schema.fields) return false;
    return schema.fields.some(
      (field) =>
        field.name === "publishedAt" ||
        field.name === "publishDate" ||
        field.name === "published"
    );
  }
}

// Usage examples:

// 1. Generate from schema directory
async function generateFromSchemaDirectory() {
  const generator = new DynamicSchemaGenerator();
  await generator.generateFromSanitySchemas(
    "../../sanity-studio/schemaTypes", // Path to schema directory
    "../migration-scripts/export-analysis.json" // Optional: sample data
  );
}

// 2. Generate from index file
async function generateFromIndexFile() {
  const generator = new DynamicSchemaGenerator();
  await generator.generateFromSanitySchemas(
    "../sanity-studio/schemaTypes/index.ts" // Path to schema index file
  );
}

// 3. Analyze from exported data (fallback method)
async function generateFromExportedData() {
  const generator = new DynamicSchemaGenerator();

  // This method analyzes the actual data to infer schema structure
  const exportData = fs.readFileSync(
    "../sanity-export/full-export.ndjson",
    "utf8"
  );
  const lines = exportData.trim().split("\n");
  const schemaAnalysis = new Map();

  // Analyze document structure
  for (const line of lines) {
    const doc = JSON.parse(line);
    if (!doc._type || doc._type.startsWith("sanity.")) continue;

    if (!schemaAnalysis.has(doc._type)) {
      schemaAnalysis.set(doc._type, {
        name: doc._type,
        type: "document",
        fields: [],
      });
    }

    const schema = schemaAnalysis.get(doc._type);

    // Infer fields from actual data
    for (const [fieldName, fieldValue] of Object.entries(doc)) {
      if (fieldName.startsWith("_")) continue;

      const existingField = schema.fields.find((f) => f.name === fieldName);
      if (!existingField) {
        schema.fields.push({
          name: fieldName,
          type: inferFieldType(fieldValue),
          title: fieldName.charAt(0).toUpperCase() + fieldName.slice(1),
        });
      }
    }
  }

  // Convert inferred schemas
  for (const schema of schemaAnalysis.values()) {
    await generator.convertSchema(schema);
  }

  await generator.generateComponents();
  await generator.generateSchemas();
  generator.printSummary();
}

// Helper function to infer field types from data
function inferFieldType(value) {
  if (value === null || value === undefined) return "string";

  if (typeof value === "string") {
    if (value.includes("@")) return "email";
    if (value.startsWith("http")) return "url";
    return "string";
  }

  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") {
    if (value._type === "slug") return "slug";
    if (value._type === "image") return "image";
    if (value._type === "file") return "file";
    if (value._ref) return "reference";
    return "object";
  }

  return "string";
}

// Export the class and usage functions
module.exports = {
  DynamicSchemaGenerator,
  generateFromSchemaDirectory,
  generateFromIndexFile,
  generateFromExportedData,
};

// Command line usage
if (require.main === module) {
  const args = process.argv.slice(2);
  const method = args[0] || "directory";

  switch (method) {
    case "directory":
      generateFromSchemaDirectory();
      break;
    case "index":
      generateFromIndexFile();
      break;
    case "data":
      generateFromExportedData();
      break;
    default:
      console.log(
        "Usage: node dynamic-schema-generator.js [directory|index|data]"
      );
  }
}
