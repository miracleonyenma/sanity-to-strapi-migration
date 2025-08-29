// migration-scripts/dynamic-schema-generator.js
const fs = require("fs-extra");
const readline = require("readline");

class DynamicSchemaGenerator {
  constructor() {
    this.sanityToStrapiTypeMap = {
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
      array: this.handleArrayField.bind(this),
      object: this.handleObjectField.bind(this),
      reference: this.handleReferenceField.bind(this),
      block: "richtext",
    };

    this.documentSchemas = new Map();
    this.objectSchemas = new Map(); // For nested objects that become components
    this.relationshipMap = new Map();
    this.fieldUsageStats = new Map();
  }

  async generateFromExport(exportFilePath, analysisFilePath = null) {
    console.log("Analyzing Sanity export for dynamic schema generation...");

    // Step 1: Analyze the export data to understand field usage
    await this.analyzeExportData(exportFilePath);

    // Step 2: If analysis file is provided, incorporate that data too
    if (analysisFilePath && fs.existsSync(analysisFilePath)) {
      await this.incorporateAnalysisData(analysisFilePath);
    }

    // Step 3: Generate Strapi schemas
    await this.generateStrapiSchemas();

    // Step 4: Generate components for nested objects
    await this.generateComponents();

    console.log("Dynamic schema generation complete!");
  }

  async analyzeExportData(exportFilePath) {
    const fileStream = fs.createReadStream(exportFilePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    console.log("Analyzing export data structure...");

    for await (const line of rl) {
      const doc = JSON.parse(line);

      // Skip system documents and assets
      if (doc._type.startsWith("sanity.") || doc._type.startsWith("system.")) {
        continue;
      }

      // Analyze document structure
      this.analyzeDocumentStructure(doc);
    }

    console.log(`Found ${this.documentSchemas.size} document types`);
  }

  analyzeDocumentStructure(doc) {
    const docType = doc._type;

    if (!this.documentSchemas.has(docType)) {
      this.documentSchemas.set(docType, {
        type: "document",
        fields: new Map(),
        sampleDoc: doc,
      });
    }

    const schema = this.documentSchemas.get(docType);

    // Analyze each field in the document
    for (const [fieldName, fieldValue] of Object.entries(doc)) {
      if (fieldName.startsWith("_")) continue; // Skip system fields

      this.analyzeField(docType, fieldName, fieldValue, schema.fields);
    }
  }

  analyzeField(docType, fieldName, fieldValue, fieldsMap) {
    const fieldType = this.inferFieldType(fieldValue);
    const fieldKey = `${docType}.${fieldName}`;

    // Track field usage statistics
    if (!this.fieldUsageStats.has(fieldKey)) {
      this.fieldUsageStats.set(fieldKey, {
        type: fieldType,
        isRequired: false,
        isArray: Array.isArray(fieldValue),
        samples: [],
        nullCount: 0,
        totalCount: 0,
      });
    }

    const stats = this.fieldUsageStats.get(fieldKey);
    stats.totalCount++;

    if (fieldValue === null || fieldValue === undefined) {
      stats.nullCount++;
    } else {
      stats.samples.push(fieldValue);
      // Keep only last 5 samples to avoid memory issues
      if (stats.samples.length > 5) {
        stats.samples = stats.samples.slice(-5);
      }
    }

    // Determine if field should be required (present in >80% of documents)
    stats.isRequired = stats.nullCount / stats.totalCount < 0.2;

    // Store field definition
    if (!fieldsMap.has(fieldName)) {
      fieldsMap.set(fieldName, {
        type: fieldType,
        isArray: Array.isArray(fieldValue),
        isReference: this.isReference(fieldValue),
        isAsset: this.isAsset(fieldValue),
        targetTypes: this.extractTargetTypes(fieldValue),
        nestedFields: this.extractNestedFields(fieldValue),
      });
    }
  }

  inferFieldType(value) {
    if (value === null || value === undefined) return "string";

    if (Array.isArray(value)) {
      if (value.length === 0) return "array";
      return this.inferFieldType(value[0]); // Check first item
    }

    if (typeof value === "string") {
      // Check for special string patterns
      if (value.match(/^\d{4}-\d{2}-\d{2}T/)) return "datetime";
      if (value.match(/^\d{4}-\d{2}-\d{2}$/)) return "date";
      if (value.includes("@") && value.includes(".")) return "email";
      if (value.startsWith("http")) return "url";
      if (value.length > 200) return "text";
      return "string";
    }

    if (typeof value === "number") {
      return Number.isInteger(value) ? "integer" : "decimal";
    }

    if (typeof value === "boolean") return "boolean";

    if (typeof value === "object") {
      if (this.isReference(value)) return "reference";
      if (this.isAsset(value))
        return value._type === "image" ? "image" : "file";
      if (this.isPortableText(value)) return "block";
      if (this.isSlug(value)) return "slug";
      return "object";
    }

    return "string";
  }

  isReference(value) {
    return value && typeof value === "object" && value._ref && !value._type;
  }

  isAsset(value) {
    return (
      value &&
      typeof value === "object" &&
      value.asset &&
      value.asset._ref &&
      (value.asset._ref.includes("image-") ||
        value.asset._ref.includes("file-"))
    );
  }

  isPortableText(value) {
    return (
      Array.isArray(value) &&
      value.some((block) => block && block._type === "block" && block.children)
    );
  }

  isSlug(value) {
    return (
      value &&
      typeof value === "object" &&
      value.current &&
      typeof value.current === "string"
    );
  }

  extractTargetTypes(value) {
    const types = new Set();

    if (Array.isArray(value)) {
      value.forEach((item) => {
        const itemTypes = this.extractTargetTypes(item);
        itemTypes.forEach((type) => types.add(type));
      });
    } else if (this.isReference(value)) {
      // Try to infer target type from the reference ID pattern
      const refId = value._ref;
      // Many Sanity refs follow pattern: type-uuid
      const typeMatch = refId.match(/^([^-]+)-/);
      if (typeMatch) {
        types.add(typeMatch[1]);
      }
    }

    return Array.from(types);
  }

  extractNestedFields(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;

    if (this.isReference(value) || this.isAsset(value) || this.isSlug(value))
      return null;

    const nestedFields = new Map();
    for (const [key, val] of Object.entries(value)) {
      if (key.startsWith("_")) continue;
      nestedFields.set(key, {
        type: this.inferFieldType(val),
        isArray: Array.isArray(val),
      });
    }

    return nestedFields.size > 0 ? nestedFields : null;
  }

  async incorporateAnalysisData(analysisFilePath) {
    console.log("Incorporating analysis data...");
    const analysisData = await fs.readJSON(analysisFilePath);

    // Use sample documents to enhance our understanding
    if (analysisData.sampleDocs) {
      for (const [docType, sampleDoc] of Object.entries(
        analysisData.sampleDocs
      )) {
        if (sampleDoc) {
          this.analyzeDocumentStructure(sampleDoc);
        }
      }
    }
  }

  async generateStrapiSchemas() {
    console.log("Generating Strapi schemas...");

    for (const [docType, schema] of this.documentSchemas) {
      const strapiSchema = await this.convertToStrapiSchema(docType, schema);

      // Create schema file
      const schemaDir = `../strapi-project/src/api/${docType}/content-types/${docType}`;
      await fs.ensureDir(schemaDir);
      await fs.writeJSON(`${schemaDir}/schema.json`, strapiSchema, {
        spaces: 2,
      });

      console.log(`✅ Generated schema for: ${docType}`);
    }
  }

  async convertToStrapiSchema(docType, schema) {
    const pluralName = this.pluralize(docType);

    const strapiSchema = {
      kind: "collectionType",
      collectionName: pluralName,
      info: {
        singularName: docType,
        pluralName: pluralName,
        displayName: this.titleCase(docType),
      },
      options: {
        draftAndPublish: true,
      },
      attributes: {},
    };

    // Convert each field
    for (const [fieldName, fieldInfo] of schema.fields) {
      const strapiField = await this.convertFieldToStrapi(
        docType,
        fieldName,
        fieldInfo
      );
      if (strapiField) {
        strapiSchema.attributes[fieldName] = strapiField;
      }
    }

    return strapiSchema;
  }

  async convertFieldToStrapi(docType, fieldName, fieldInfo) {
    const fieldKey = `${docType}.${fieldName}`;
    const stats = this.fieldUsageStats.get(fieldKey);

    let strapiField = {};

    // Handle different field types
    switch (fieldInfo.type) {
      case "reference":
        return this.handleReferenceField(fieldInfo, stats);

      case "image":
      case "file":
        return {
          type: "media",
          multiple: fieldInfo.isArray,
          required: stats?.isRequired || false,
          allowedTypes:
            fieldInfo.type === "image"
              ? ["images"]
              : ["files", "images", "videos"],
        };

      case "array":
        return this.handleArrayField(fieldInfo, stats);

      case "object":
        return this.handleObjectField(docType, fieldName, fieldInfo);

      case "block":
        return { type: "richtext" };

      case "slug":
        return {
          type: "uid",
          targetField: "title", // Default to title, might need manual adjustment
        };

      default:
        strapiField = {
          type: this.sanityToStrapiTypeMap[fieldInfo.type] || "string",
        };
    }

    // Add common properties
    if (stats?.isRequired) {
      strapiField.required = true;
    }

    // Add validation for specific types
    if (fieldInfo.type === "email") {
      strapiField.type = "email";
    } else if (fieldInfo.type === "url") {
      strapiField.type = "string";
    }

    return strapiField;
  }

  handleReferenceField(fieldInfo, stats) {
    if (fieldInfo.isArray) {
      return {
        type: "relation",
        relation: "manyToMany",
        target:
          fieldInfo.targetTypes.length > 0
            ? `api::${fieldInfo.targetTypes[0]}.${fieldInfo.targetTypes[0]}`
            : "plugin::users-permissions.user", // fallback
        required: stats?.isRequired || false,
      };
    } else {
      return {
        type: "relation",
        relation: "manyToOne",
        target:
          fieldInfo.targetTypes.length > 0
            ? `api::${fieldInfo.targetTypes[0]}.${fieldInfo.targetTypes[0]}`
            : "plugin::users-permissions.user", // fallback
        required: stats?.isRequired || false,
      };
    }
  }

  handleArrayField(fieldInfo, stats) {
    // Arrays in Sanity can be many things - we need to look at the content
    const sample = stats?.samples?.[0];

    if (Array.isArray(sample) && sample.length > 0) {
      const firstItem = sample[0];

      if (this.isReference(firstItem)) {
        return this.handleReferenceField(
          { ...fieldInfo, isArray: true },
          stats
        );
      } else if (this.isAsset(firstItem)) {
        return {
          type: "media",
          multiple: true,
          allowedTypes: ["images", "files", "videos"],
        };
      } else if (this.isPortableText(sample)) {
        return { type: "richtext" };
      } else if (typeof firstItem === "string") {
        return { type: "json" }; // Store as JSON for string arrays
      }
    }

    return { type: "json" }; // Fallback to JSON for complex arrays
  }

  handleObjectField(docType, fieldName, fieldInfo) {
    if (!fieldInfo.nestedFields) {
      return { type: "json" };
    }

    // Create a component for this nested object
    const componentName = `${docType}-${fieldName}`;
    this.objectSchemas.set(componentName, {
      fields: fieldInfo.nestedFields,
      displayName: this.titleCase(`${docType} ${fieldName}`),
    });

    return {
      type: "component",
      repeatable: false,
      component: `${docType}.${fieldName}`,
    };
  }

  async generateComponents() {
    console.log("Generating components...");

    for (const [componentName, componentInfo] of this.objectSchemas) {
      const [category, name] = componentName.split("-");

      const component = {
        collectionName: `components_${category}_${name}`,
        info: {
          displayName: componentInfo.displayName,
          icon: "cube",
        },
        options: {},
        attributes: {},
      };

      // Convert nested fields
      for (const [fieldName, fieldInfo] of componentInfo.fields) {
        const strapiField = {
          type: this.sanityToStrapiTypeMap[fieldInfo.type] || "string",
        };

        if (fieldInfo.isArray) {
          strapiField.type = "json"; // Store arrays as JSON in components
        }

        component.attributes[fieldName] = strapiField;
      }

      // Create component file
      const componentDir = `../strapi-project/src/components/${category}`;
      await fs.ensureDir(componentDir);
      await fs.writeJSON(`${componentDir}/${name}.json`, component, {
        spaces: 2,
      });

      console.log(`✅ Generated component: ${category}.${name}`);
    }
  }

  pluralize(word) {
    // Basic pluralization rules
    if (word.endsWith("y")) {
      return word.slice(0, -1) + "ies";
    } else if (
      word.endsWith("s") ||
      word.endsWith("sh") ||
      word.endsWith("ch")
    ) {
      return word + "es";
    } else {
      return word + "s";
    }
  }

  titleCase(str) {
    return str
      .split(/[-_]/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }

  // Generate migration report
  async generateMigrationReport() {
    const report = {
      generatedAt: new Date().toISOString(),
      documentTypes: {},
      components: {},
      summary: {
        totalDocumentTypes: this.documentSchemas.size,
        totalComponents: this.objectSchemas.size,
        fieldsMapped: this.fieldUsageStats.size,
      },
    };

    // Document type details
    for (const [docType, schema] of this.documentSchemas) {
      report.documentTypes[docType] = {
        fieldCount: schema.fields.size,
        fields: {},
      };

      for (const [fieldName, fieldInfo] of schema.fields) {
        const fieldKey = `${docType}.${fieldName}`;
        const stats = this.fieldUsageStats.get(fieldKey);

        report.documentTypes[docType].fields[fieldName] = {
          sanityType: fieldInfo.type,
          strapiType: this.getStrapiTypeForField(fieldInfo),
          isRequired: stats?.isRequired || false,
          isArray: fieldInfo.isArray,
          usageRate: stats ? 1 - stats.nullCount / stats.totalCount : 0,
        };
      }
    }

    // Component details
    for (const [componentName, componentInfo] of this.objectSchemas) {
      report.components[componentName] = {
        fieldCount: componentInfo.fields.size,
        displayName: componentInfo.displayName,
      };
    }

    await fs.writeJSON(
      "../migration-scripts/schema-generation-report.json",
      report,
      { spaces: 2 }
    );
    console.log("📄 Migration report saved to schema-generation-report.json");
  }

  getStrapiTypeForField(fieldInfo) {
    if (fieldInfo.type === "reference") {
      return fieldInfo.isArray
        ? "relation (manyToMany)"
        : "relation (manyToOne)";
    }
    return this.sanityToStrapiTypeMap[fieldInfo.type] || "string";
  }
}

// Usage
async function main() {
  const generator = new DynamicSchemaGenerator();

  try {
    await generator.generateFromExport(
      "../sanity-export/full-export.ndjson",
      "../migration-scripts/export-analysis.json"
    );

    await generator.generateMigrationReport();

    console.log("\n🎉 Dynamic schema generation complete!");
    console.log("📁 Check ../strapi-project/src/api/ for generated schemas");
    console.log(
      "📁 Check ../strapi-project/src/components/ for generated components"
    );
    console.log(
      "📄 Check schema-generation-report.json for detailed mapping info"
    );
  } catch (error) {
    console.error("❌ Schema generation failed:", error);
  }
}

// Run if this file is executed directly
if (require.main === module) {
  main();
}

module.exports = DynamicSchemaGenerator;
