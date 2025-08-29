// migration-scripts/dynamic-schema-generator.js
const fs = require("fs-extra");
const path = require("path");
const readline = require("readline");

class DynamicSchemaGenerator {
  constructor() {
    this.typeMapping = {
      string: "string",
      text: "text",
      number: "decimal",
      boolean: "boolean",
      datetime: "datetime",
      date: "date",
      email: "string",
      url: "string",
      slug: "uid",
      image: "media",
      file: "media",
      reference: "relation",
      array: this.handleArrayType.bind(this),
      object: "component",
      block: "blocks", // Strapi's rich text field type
    };

    this.schemas = new Map();
    this.components = new Map();
    this.relationships = new Map();
    this.documentCounts = new Map();
    this.singletonTypes = new Set();
  }

  // Main entry point for schema generation
  async generateFromSanityProject(sanityProjectPath, exportedDataPath) {
    console.log("Starting dynamic schema generation...");

    // Step 1: Analyze Sanity schema files
    await this.analyzeSanitySchemas(sanityProjectPath);

    // Step 2: Analyze exported data for validation and document counts
    await this.analyzeExportedData(exportedDataPath);

    // Step 3: Generate Strapi schemas
    await this.generateStrapiSchemas();

    // Step 4: Generate report
    await this.generateReport();

    console.log("Schema generation complete!");
  }

  async analyzeSanitySchemas(sanityProjectPath) {
    console.log("Analyzing Sanity schemas...");

    const schemaPath = path.join(sanityProjectPath, "schemaTypes");

    if (!fs.existsSync(schemaPath)) {
      throw new Error(`Schema path not found: ${schemaPath}`);
    }

    // Check if it's organized in folders or flat structure
    const schemaStructure = await this.detectSchemaStructure(schemaPath);

    if (schemaStructure.organized) {
      await this.parseOrganizedSchemas(schemaPath, schemaStructure);
    } else {
      await this.parseFlatSchemas(schemaPath);
    }
  }

  async detectSchemaStructure(schemaPath) {
    const items = await fs.readdir(schemaPath);
    const structure = {
      organized: false,
      folders: [],
      files: [],
    };

    for (const item of items) {
      const itemPath = path.join(schemaPath, item);
      const stat = await fs.stat(itemPath);

      if (stat.isDirectory()) {
        structure.folders.push(item);
        structure.organized = true;
      } else if (item.endsWith(".ts") || item.endsWith(".js")) {
        structure.files.push(item);
      }
    }

    return structure;
  }

  async parseOrganizedSchemas(schemaPath, structure) {
    // Parse organized schema structure (documents, objects, singletons)
    for (const folder of structure.folders) {
      const folderPath = path.join(schemaPath, folder);
      const files = await fs.readdir(folderPath);

      for (const file of files) {
        if (file.endsWith(".ts") || file.endsWith(".js")) {
          const schemaInfo = await this.parseSchemaFile(
            path.join(folderPath, file)
          );
          if (schemaInfo) {
            // Mark singletons ONLY from folder structure or filename
            if (
              folder === "singletons" ||
              folder === "singleton" ||
              file.includes(".singleton.")
            ) {
              this.singletonTypes.add(schemaInfo.name);
            }

            if (schemaInfo.type === "document") {
              this.schemas.set(schemaInfo.name, schemaInfo);
            } else if (schemaInfo.type === "object") {
              this.components.set(schemaInfo.name, schemaInfo);
            }
          }
        }
      }
    }
  }

  async parseFlatSchemas(schemaPath) {
    // Parse flat schema structure
    const files = await fs.readdir(schemaPath);

    for (const file of files) {
      if (
        (file.endsWith(".ts") || file.endsWith(".js")) &&
        file !== "index.ts" &&
        file !== "index.js"
      ) {
        const schemaInfo = await this.parseSchemaFile(
          path.join(schemaPath, file)
        );
        if (schemaInfo) {
          // Check for singleton in filename pattern
          if (file.includes(".singleton.")) {
            this.singletonTypes.add(schemaInfo.name);
          }

          if (schemaInfo.type === "document") {
            this.schemas.set(schemaInfo.name, schemaInfo);
          } else if (schemaInfo.type === "object") {
            this.components.set(schemaInfo.name, schemaInfo);
          }
        }
      }
    }
  }

  async parseSchemaFile(filePath) {
    try {
      const content = await fs.readFile(filePath, "utf8");

      // Extract schema definition using regex patterns
      const schemaInfo = this.extractSchemaFromContent(content);
      return schemaInfo;
    } catch (error) {
      console.warn(`Could not parse schema file ${filePath}:`, error.message);
      return null;
    }
  }

  extractSchemaFromContent(content) {
    // Extract schema name
    const nameMatch = content.match(/name:\s*['"](.*?)['"]/);
    if (!nameMatch) return null;

    const name = nameMatch[1];

    // Extract type
    const typeMatch = content.match(/type:\s*['"](.*?)['"]/);
    const type = typeMatch ? typeMatch[1] : "document";

    // Extract title
    const titleMatch = content.match(/title:\s*['"](.*?)['"]/);
    const title = titleMatch ? titleMatch[1] : name;

    // Extract fields
    const fields = this.extractFields(content);

    return {
      name,
      type,
      title,
      fields,
    };
  }

  extractFields(content) {
    const fields = [];

    // More sophisticated field extraction using regex
    const fieldPattern =
      /defineField\(\s*\{([^{}]*(?:\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}[^{}]*)*)\}\)/gs;
    const fieldMatches = content.matchAll(fieldPattern);

    for (const match of fieldMatches) {
      const fieldContent = match[1];
      const field = this.parseFieldContent(fieldContent);
      if (field) {
        fields.push(field);
      }
    }

    return fields;
  }

  parseFieldContent(fieldContent) {
    try {
      // Extract basic properties
      const name = this.extractProperty(fieldContent, "name");
      const type = this.extractProperty(fieldContent, "type");
      const title = this.extractProperty(fieldContent, "title");

      if (!name || !type) return null;

      const field = { name, type, title };

      // Extract validation rules
      const validation = this.extractValidation(fieldContent);
      if (validation) {
        field.validation = validation;
      }

      // Extract options
      const options = this.extractOptions(fieldContent);
      if (options) {
        field.options = options;
      }

      // Extract array 'of' property
      const arrayOf = this.extractArrayOf(fieldContent);
      if (arrayOf) {
        field.of = arrayOf;
      }

      // Extract reference 'to' property
      const referenceTo = this.extractReferenceTo(fieldContent);
      if (referenceTo) {
        field.to = referenceTo;
      }

      // Extract nested fields for objects - IMPROVED VERSION
      const nestedFields = this.extractNestedFields(fieldContent);
      if (nestedFields && nestedFields !== "HAS_NESTED_FIELDS") {
        field.fields = nestedFields;
      }

      return field;
    } catch (error) {
      console.warn("Error parsing field:", error.message);
      return null;
    }
  }

  extractProperty(content, propName) {
    const pattern = new RegExp(`${propName}:\\s*['"](.*?)['"]`);
    const match = content.match(pattern);
    return match ? match[1] : null;
  }

  extractValidation(content) {
    const validationMatch = content.match(
      /validation:\s*\([^)]*\)\s*=>\s*([^,}]+)/
    );
    if (!validationMatch) return null;

    const validationString = validationMatch[1];
    const validation = {};

    if (validationString.includes(".required()")) {
      validation.required = true;
    }

    const minMatch = validationString.match(/\.min\((\d+)\)/);
    if (minMatch) {
      validation.min = parseInt(minMatch[1]);
    }

    const maxMatch = validationString.match(/\.max\((\d+)\)/);
    if (maxMatch) {
      validation.max = parseInt(maxMatch[1]);
    }

    return Object.keys(validation).length > 0 ? validation : null;
  }

  extractOptions(content) {
    const optionsMatch = content.match(
      /options:\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/
    );
    if (!optionsMatch) return null;

    const optionsContent = optionsMatch[1];
    const options = {};

    // Extract source for slug fields
    const sourceMatch = optionsContent.match(/source:\s*['"]([^'"]*)['"]/);
    if (sourceMatch) {
      options.source = sourceMatch[1];
    }

    // Extract list options
    const listMatch = optionsContent.match(/list:\s*\[([^\]]*)\]/);
    if (listMatch) {
      try {
        const listItems = listMatch[1].match(/\{[^}]*\}/g);
        if (listItems) {
          options.list = listItems.map((item) => {
            const titleMatch = item.match(/title:\s*['"]([^'"]*)['"]/);
            const valueMatch = item.match(/value:\s*['"]([^'"]*)['"]/);
            return {
              title: titleMatch ? titleMatch[1] : "",
              value: valueMatch ? valueMatch[1] : "",
            };
          });
        }
      } catch (e) {
        console.warn("Could not parse list options");
      }
    }

    return Object.keys(options).length > 0 ? options : null;
  }

  extractArrayOf(content) {
    const ofMatch = content.match(/of:\s*\[([^\]]*)\]/);
    if (!ofMatch) return null;

    try {
      const ofContent = ofMatch[1];
      const items = [];

      // Handle simple types like [{type: 'string'}]
      const typeMatches = ofContent.matchAll(
        /\{[^}]*type:\s*['"]([^'"]*)['"]/g
      );
      for (const match of typeMatches) {
        items.push({ type: match[1] });
      }

      return items.length > 0 ? items : null;
    } catch (error) {
      return null;
    }
  }

  extractReferenceTo(content) {
    const toMatch = content.match(/to:\s*\[([^\]]*)\]/);
    if (!toMatch) return null;

    try {
      const toContent = toMatch[1];
      const items = [];

      const typeMatches = toContent.matchAll(
        /\{[^}]*type:\s*['"]([^'"]*)['"]/g
      );
      for (const match of typeMatches) {
        items.push({ type: match[1] });
      }

      return items.length > 0 ? items : null;
    } catch (error) {
      return null;
    }
  }

  // IMPROVED nested fields extraction
  extractNestedFields(content) {
    const fieldsMatch = content.match(
      /fields:\s*\[([^\[\]]*(?:\[[^\]]*\][^\[\]]*)*)\]/s
    );
    if (!fieldsMatch) return null;

    const fieldsContent = fieldsMatch[1];
    const fields = [];

    // Extract individual field objects from the fields array
    const fieldObjectPattern = /\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
    const fieldMatches = fieldsContent.matchAll(fieldObjectPattern);

    for (const match of fieldMatches) {
      const fieldContent = match[1];

      const name = this.extractProperty(fieldContent, "name");
      const type = this.extractProperty(fieldContent, "type");
      const title = this.extractProperty(fieldContent, "title");

      if (name && type) {
        const field = { name, type };
        if (title) field.title = title;
        fields.push(field);
      }
    }

    return fields.length > 0 ? fields : null;
  }

  async analyzeExportedData(exportPath) {
    console.log("Analyzing exported data...");

    const ndjsonPath = path.join(exportPath, "data.ndjson");
    if (!fs.existsSync(ndjsonPath)) {
      console.warn("No data.ndjson found, skipping data analysis");
      return;
    }

    const fileStream = fs.createReadStream(ndjsonPath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    const typeCount = {};
    const sampleDocs = {};

    for await (const line of rl) {
      try {
        const doc = JSON.parse(line);

        // Skip asset documents
        if (doc._type.startsWith("sanity.")) continue;

        typeCount[doc._type] = (typeCount[doc._type] || 0) + 1;

        // Store sample document for each type
        if (!sampleDocs[doc._type]) {
          sampleDocs[doc._type] = doc;
        }
      } catch (error) {
        // Skip invalid lines
      }
    }

    // Store document counts but DON'T automatically mark as singletons
    Object.entries(typeCount).forEach(([type, count]) => {
      this.documentCounts.set(type, count);

      // Only log potential singletons for manual review, don't auto-mark
      if (count === 1 && !this.singletonTypes.has(type)) {
        console.log(
          `Info: ${type} has only 1 document - consider if this should be a singleton`
        );
      }
    });

    console.log(`Analyzed ${Object.keys(typeCount).length} document types`);
    console.log("Document counts:", typeCount);
  }

  convertToStrapiSchema(sanitySchema) {
    const isSingleton = this.singletonTypes.has(sanitySchema.name);
    const documentCount = this.documentCounts.get(sanitySchema.name) || 0;

    const strapiSchema = {
      kind: isSingleton ? "singleType" : "collectionType",
      collectionName: isSingleton
        ? sanitySchema.name
        : this.pluralize(sanitySchema.name),
      info: {
        singularName: sanitySchema.name,
        pluralName: this.pluralize(sanitySchema.name),
        displayName: sanitySchema.title || sanitySchema.name,
        description: `Migrated from Sanity (${documentCount} documents)`,
      },
      options: {
        draftAndPublish: true,
      },
      pluginOptions: {},
      attributes: {},
    };

    // Convert fields
    for (const field of sanitySchema.fields) {
      const strapiField = this.convertField(field, sanitySchema.name);
      if (strapiField) {
        strapiSchema.attributes[field.name] = strapiField;
      }
    }

    return strapiSchema;
  }

  convertField(field, parentSchemaName) {
    const fieldType = field.type;

    // Handle special cases first
    if (fieldType === "slug") {
      return {
        type: "uid",
        targetField: field.options?.source || "title",
        required: field.validation?.required || false,
      };
    }

    if (fieldType === "reference") {
      const targetType = field.to?.[0]?.type;
      if (targetType) {
        // Store relationship for later processing
        this.storeRelationship(parentSchemaName, field.name, targetType, false);

        return {
          type: "relation",
          relation: "oneToMany", // Changed from manyToOne to oneToMany as per expected output
          target: `api::${targetType}.${targetType}`,
        };
      }
    }

    if (fieldType === "array") {
      return this.handleArrayField(field, parentSchemaName);
    }

    if (fieldType === "object") {
      return this.handleObjectField(field, parentSchemaName);
    }

    if (fieldType === "image" || fieldType === "file") {
      return {
        type: "media",
        multiple: false,
        allowedTypes: ["images", "files", "videos", "audios"], // Match expected format
      };
    }

    // Handle primitive types
    const strapiType = this.typeMapping[fieldType] || "string";
    const strapiField = { type: strapiType };

    // Add validation rules
    if (field.validation?.required) {
      strapiField.required = true;
    }

    if (field.validation?.min !== undefined) {
      strapiField.min = field.validation.min;
    }

    if (field.validation?.max !== undefined) {
      strapiField.max = field.validation.max;
    }

    // Handle enumeration from options
    if (field.options?.list) {
      strapiField.type = "enumeration";
      strapiField.enum = field.options.list.map((item) => item.value);
    }

    return strapiField;
  }

  handleArrayField(field, parentSchemaName) {
    const arrayItemType = field.of?.[0]?.type;

    if (!arrayItemType) {
      return { type: "json" }; // Fallback for complex arrays
    }

    if (arrayItemType === "reference") {
      const targetType = field.of[0].to?.[0]?.type;
      if (targetType) {
        this.storeRelationship(parentSchemaName, field.name, targetType, true);

        return {
          type: "relation",
          relation: "oneToMany", // Changed from manyToMany to oneToMany as per expected output
          target: `api::${targetType}.${targetType}`,
        };
      }
    }

    if (arrayItemType === "string") {
      // Create a component for array of strings with better naming
      const componentName = field.name; // Use field name directly
      const componentKey = this.getComponentKey(field.name);

      this.createStringArrayComponent(
        componentName,
        field.title || field.name,
        componentKey
      );

      return {
        type: "component",
        repeatable: true,
        component: componentKey,
      };
    }

    if (arrayItemType === "image" || arrayItemType === "file") {
      return {
        type: "media",
        multiple: true,
        allowedTypes: ["images", "files", "videos", "audios"], // Match expected format
      };
    }

    if (arrayItemType === "block") {
      return { type: "blocks" }; // Strapi rich text
    }

    if (arrayItemType === "object" || this.components.has(arrayItemType)) {
      // Reference existing component or create new one
      const componentKey = this.getComponentKey(field.name);
      return {
        type: "component",
        repeatable: true,
        component: componentKey,
      };
    }

    // Fallback for complex arrays
    return { type: "json" };
  }

  handleObjectField(field, parentSchemaName) {
    // Use field name as component name and create proper component key
    const componentKey = this.getComponentKey(field.name);

    // Create component schema for this object with proper field parsing
    this.createObjectComponent(field.name, field, componentKey);

    return {
      type: "component",
      repeatable: false,
      component: componentKey,
    };
  }

  // Helper method to generate component keys in expected format
  getComponentKey(fieldName) {
    const category = this.singularize(fieldName);
    const componentName = this.pluralize(fieldName);
    return `${category}.${componentName}`;
  }

  createStringArrayComponent(componentName, title, componentKey) {
    const [category, name] = componentKey.split(".");

    const component = {
      collectionName: `components_${category}_${this.pluralize(name)}`,
      info: {
        displayName: this.singularize(componentName),
      },
      options: {},
      attributes: {
        name: {
          // Changed from 'value' to 'name' as per expected output
          type: "string",
        },
      },
      config: {},
    };

    this.components.set(componentKey, component);
  }

  createObjectComponent(componentName, field, componentKey) {
    const [category, name] = componentKey.split(".");

    const component = {
      collectionName: `components_${category}_${this.pluralize(name)}`,
      info: {
        displayName: this.singularize(componentName),
      },
      options: {},
      attributes: {},
      config: {},
    };

    // Parse nested fields properly
    if (field.fields && Array.isArray(field.fields)) {
      for (const nestedField of field.fields) {
        const strapiField = this.convertNestedField(nestedField);
        if (strapiField) {
          component.attributes[nestedField.name] = strapiField;
        }
      }
    } else {
      // Fallback to json if we can't parse nested fields
      component.attributes.data = {
        type: "json",
      };
    }

    this.components.set(componentKey, component);
  }

  convertNestedField(field) {
    const fieldType = field.type;

    if (fieldType === "image" || fieldType === "file") {
      return {
        type: "media",
        multiple: false,
        allowedTypes: ["images", "files", "videos", "audios"],
      };
    }

    // Handle primitive types
    const strapiType = this.typeMapping[fieldType] || "string";
    return { type: strapiType };
  }

  storeRelationship(fromType, fieldName, toType, isArray) {
    if (!this.relationships.has(fromType)) {
      this.relationships.set(fromType, []);
    }

    this.relationships.get(fromType).push({
      fieldName,
      targetType: toType,
      isArray,
      relation: "oneToMany", // Changed default to oneToMany
    });
  }

  async generateStrapiSchemas() {
    console.log("Generating Strapi schemas...");

    const strapiProjectPath = "../strapi-project";

    // Generate collection/single type schemas
    for (const [typeName, sanitySchema] of this.schemas) {
      const strapiSchema = this.convertToStrapiSchema(sanitySchema);

      // Create directory structure
      const schemaDir = path.join(
        strapiProjectPath,
        "src/api",
        typeName,
        "content-types",
        typeName
      );
      await fs.ensureDir(schemaDir);

      // Write schema file
      await fs.writeJSON(path.join(schemaDir, "schema.json"), strapiSchema, {
        spaces: 2,
      });

      // Generate controller, routes, and services
      await this.generateApiFiles(typeName, strapiProjectPath);

      console.log(`Generated schema for: ${typeName} (${strapiSchema.kind})`);
    }

    // Generate components with improved structure
    for (const [componentKey, component] of this.components) {
      const [categoryName, componentFileName] = componentKey.split(".");

      const componentDir = path.join(
        strapiProjectPath,
        "src/components",
        categoryName
      );
      await fs.ensureDir(componentDir);

      await fs.writeJSON(
        path.join(componentDir, `${componentFileName}.json`),
        component,
        { spaces: 2 }
      );

      console.log(`Generated component: ${categoryName}/${componentFileName}`);
    }
  }

  async generateApiFiles(typeName, strapiProjectPath) {
    const apiPath = path.join(strapiProjectPath, "src/api", typeName);

    // Controller
    const controllerDir = path.join(apiPath, "controllers");
    await fs.ensureDir(controllerDir);
    await fs.writeFile(
      path.join(controllerDir, `${typeName}.ts`),
      this.generateControllerTemplate(typeName)
    );

    // Routes
    const routesDir = path.join(apiPath, "routes");
    await fs.ensureDir(routesDir);
    await fs.writeFile(
      path.join(routesDir, `${typeName}.ts`),
      this.generateRoutesTemplate(typeName)
    );

    // Services
    const servicesDir = path.join(apiPath, "services");
    await fs.ensureDir(servicesDir);
    await fs.writeFile(
      path.join(servicesDir, `${typeName}.ts`),
      this.generateServiceTemplate(typeName)
    );
  }

  generateControllerTemplate(typeName) {
    return `/**
 * ${typeName} controller
 */

import { factories } from '@strapi/strapi'

export default factories.createCoreController('api::${typeName}.${typeName}');`;
  }

  generateRoutesTemplate(typeName) {
    return `/**
 * ${typeName} router
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::${typeName}.${typeName}');`;
  }

  generateServiceTemplate(typeName) {
    return `/**
 * ${typeName} service
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreService('api::${typeName}.${typeName}');`;
  }

  async generateReport() {
    const report = {
      generatedAt: new Date().toISOString(),
      summary: {
        totalSchemas: this.schemas.size,
        totalComponents: this.components.size,
        singletonTypes: Array.from(this.singletonTypes),
        totalDocuments: Array.from(this.documentCounts.values()).reduce(
          (sum, count) => sum + count,
          0
        ),
      },
      schemas: Array.from(this.schemas.entries()).map(([name, schema]) => ({
        name,
        type: this.singletonTypes.has(name) ? "singleton" : "collection",
        documentCount: this.documentCounts.get(name) || 0,
        fieldCount: schema.fields.length,
      })),
      components: Array.from(this.components.keys()),
      relationships: Object.fromEntries(this.relationships),
    };

    await fs.writeJSON("schema-generation-report.json", report, { spaces: 2 });
    console.log("Generated migration report: schema-generation-report.json");
  }

  // Utility methods
  pluralize(word) {
    if (word.endsWith("y")) {
      return word.slice(0, -1) + "ies";
    }
    if (
      word.endsWith("s") ||
      word.endsWith("sh") ||
      word.endsWith("ch") ||
      word.endsWith("x") ||
      word.endsWith("z")
    ) {
      return word + "es";
    }
    return word + "s";
  }

  singularize(word) {
    if (word.endsWith("ies")) {
      return word.slice(0, -3) + "y";
    }
    if (word.endsWith("es")) {
      return word.slice(0, -2);
    }
    if (word.endsWith("s") && !word.endsWith("ss")) {
      return word.slice(0, -1);
    }
    return word;
  }

  kebabCase(str) {
    return str
      .replace(/([a-z])([A-Z])/g, "$1-$2")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }

  handleArrayType(field, parentSchemaName) {
    // This method signature is for the type mapping - actual handling is in handleArrayField
    return this.handleArrayField(field, parentSchemaName);
  }
}

module.exports = DynamicSchemaGenerator;
