// migration-scripts/universal-content-migrator.js
const fs = require("fs-extra");
const path = require("path");
const readline = require("readline");
const axios = require("axios");
const FormData = require("form-data");
const { v2: cloudinary } = require("cloudinary");

class UniversalContentMigrator {
  constructor(config = {}) {
    this.config = {
      strapiUrl: config.strapiUrl || "http://localhost:1337",
      apiToken: config.apiToken || "",
      assetProvider: config.assetProvider || "strapi", // 'strapi' or 'cloudinary'
      cloudinary: config.cloudinary || {},
      batchSize: config.batchSize || 10,
      retryAttempts: config.retryAttempts || 3,
      retryDelay: config.retryDelay || 1000,
      strapiProjectPath: config.strapiProjectPath || "../strapi-project",
      ...config,
    };

    // Initialize Cloudinary if configured
    if (
      this.config.assetProvider === "cloudinary" &&
      this.config.cloudinary.cloud_name
    ) {
      cloudinary.config(this.config.cloudinary);
    }

    // State management
    this.migrationState = {
      assets: new Map(), // sanityAssetId -> strapiAssetId/cloudinaryUrl
      entities: new Map(), // sanityId -> strapiId
      pendingRelationships: [], // Relationships to update after all entities are created
      errors: [],
      progress: {
        assets: { total: 0, completed: 0, failed: 0 },
        entities: { total: 0, completed: 0, failed: 0 },
        relationships: { total: 0, completed: 0, failed: 0 },
      },
    };

    // Schema mapping - loaded from generated Strapi schemas
    this.schemaMapping = new Map(); // sanityType -> strapiSchema
    this.componentMapping = new Map(); // componentKey -> component schema

    // API client setup
    this.strapiApi = axios.create({
      baseURL: this.config.strapiUrl,
      headers: {
        Authorization: `Bearer ${this.config.apiToken}`,
        "Content-Type": "application/json",
      },
    });
  }

  // Load schema mapping from generated Strapi project
  async loadSchemaMapping() {
    console.log("Loading schema mapping from Strapi project...");

    const apiPath = path.join(this.config.strapiProjectPath, "src/api");
    const componentsPath = path.join(
      this.config.strapiProjectPath,
      "src/components"
    );

    // Load content type schemas
    if (fs.existsSync(apiPath)) {
      const contentTypes = await fs.readdir(apiPath);

      for (const contentType of contentTypes) {
        const schemaPath = path.join(
          apiPath,
          contentType,
          "content-types",
          contentType,
          "schema.json"
        );

        if (fs.existsSync(schemaPath)) {
          try {
            const schema = await fs.readJSON(schemaPath);
            this.schemaMapping.set(contentType, schema);
            console.log(`Loaded schema for: ${contentType}`);
          } catch (error) {
            console.warn(
              `Failed to load schema for ${contentType}:`,
              error.message
            );
          }
        }
      }
    }

    // Load component schemas
    if (fs.existsSync(componentsPath)) {
      const categories = await fs.readdir(componentsPath);

      for (const category of categories) {
        const categoryPath = path.join(componentsPath, category);
        if (!fs.statSync(categoryPath).isDirectory()) continue;

        const components = await fs.readdir(categoryPath);
        for (const componentFile of components) {
          if (!componentFile.endsWith(".json")) continue;

          const componentPath = path.join(categoryPath, componentFile);
          const componentName = path.basename(componentFile, ".json");
          const componentKey = `${category}.${componentName}`;

          try {
            const component = await fs.readJSON(componentPath);
            this.componentMapping.set(componentKey, component);
            console.log(`Loaded component: ${componentKey}`);
          } catch (error) {
            console.warn(
              `Failed to load component ${componentKey}:`,
              error.message
            );
          }
        }
      }
    }

    console.log(
      `Loaded ${this.schemaMapping.size} schemas and ${this.componentMapping.size} components`
    );
  }

  // Main migration entry point
  async migrate(sanityExportPath) {
    console.log("Starting universal Sanity to Strapi content migration...");
    console.log(`Source: ${sanityExportPath}`);
    console.log(`Target: ${this.config.strapiUrl}`);
    console.log(`Asset provider: ${this.config.assetProvider}`);

    try {
      // Step 1: Load schema mapping
      await this.loadSchemaMapping();

      // Step 2: Load and parse Sanity export data
      const { documents, assets } = await this.loadSanityData(sanityExportPath);
      console.log(
        `Loaded ${documents.length} documents and ${assets.length} assets`
      );

      // Step 3: Migrate assets first
      await this.migrateAssets(assets, sanityExportPath);

      // Step 4: Migrate content in dependency order
      await this.migrateContent(documents);

      // Step 5: Process pending relationships
      await this.processPendingRelationships();

      // Step 6: Generate migration report
      await this.generateMigrationReport();

      console.log("Migration completed successfully!");
      this.printSummary();
    } catch (error) {
      console.error("Migration failed:", error.message);
      throw error;
    }
  }

  // Load and parse Sanity export data
  async loadSanityData(exportPath) {
    const ndjsonPath = path.join(exportPath, "data.ndjson");
    const assetsPath = path.join(exportPath, "assets.json");

    if (!fs.existsSync(ndjsonPath)) {
      throw new Error(`data.ndjson not found at ${ndjsonPath}`);
    }

    // Load documents
    const documents = [];
    const fileStream = fs.createReadStream(ndjsonPath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      try {
        const doc = JSON.parse(line);
        if (!doc._type.startsWith("sanity.")) {
          documents.push(doc);
        }
      } catch (error) {
        console.warn(`Skipped invalid JSON line: ${line.substring(0, 100)}...`);
      }
    }

    // Load assets
    let assets = [];
    if (fs.existsSync(assetsPath)) {
      try {
        const assetsData = await fs.readJSON(assetsPath);
        assets = Object.entries(assetsData).map(([key, asset]) => ({
          ...asset,
          _key: key.replace("image-", "").replace("file-", ""),
        }));
      } catch (error) {
        console.warn("Could not load assets.json:", error.message);
      }
    }

    return { documents, assets };
  }

  // Asset migration (unchanged from original)
  async migrateAssets(assets, exportPath) {
    if (assets.length === 0) {
      console.log("No assets to migrate");
      return;
    }

    console.log(`Migrating ${assets.length} assets...`);
    this.migrationState.progress.assets.total = assets.length;

    const imagesPath = path.join(exportPath, "images");

    for (const asset of assets) {
      try {
        const assetResult = await this.migrateAsset(asset, imagesPath);
        if (assetResult) {
          this.migrationState.assets.set(asset._key, assetResult);
          this.migrationState.progress.assets.completed++;
          console.log(
            `Asset migrated: ${asset.originalFilename} -> ${
              assetResult.id || assetResult.url
            }`
          );
        }
      } catch (error) {
        this.migrationState.progress.assets.failed++;
        this.migrationState.errors.push({
          type: "asset",
          id: asset._key,
          error: error.message,
        });
        console.error(
          `Failed to migrate asset ${asset.originalFilename}:`,
          error.message
        );
      }
    }
  }

  async migrateAsset(asset, imagesPath) {
    const filename = `${asset.sha1hash}-${asset.metadata.dimensions.width}x${asset.metadata.dimensions.height}.png`;
    const filePath = path.join(imagesPath, filename);

    if (!fs.existsSync(filePath)) {
      console.warn(`Asset file not found: ${filePath}`);
      return null;
    }

    if (this.config.assetProvider === "cloudinary") {
      return await this.uploadToCloudinary(filePath, asset);
    } else {
      return await this.uploadToStrapi(filePath, asset);
    }
  }

  async uploadToStrapi(filePath, asset) {
    const formData = new FormData();
    formData.append("files", fs.createReadStream(filePath), {
      filename: asset.originalFilename,
      contentType: this.getMimeType(asset.originalFilename),
    });

    const response = await this.strapiApi.post("/api/upload", formData, {
      headers: {
        ...formData.getHeaders(),
      },
    });

    return {
      id: response.data[0].id,
      url: response.data[0].url,
      provider: "strapi",
    };
  }

  async uploadToCloudinary(filePath, asset) {
    const result = await cloudinary.uploader.upload(filePath, {
      public_id: asset.sha1hash,
      folder: "sanity-migration",
      use_filename: true,
      unique_filename: false,
    });

    return {
      id: result.public_id,
      url: result.secure_url,
      provider: "cloudinary",
    };
  }

  // Content migration with schema-aware transformation
  async migrateContent(documents) {
    console.log(`Migrating ${documents.length} documents...`);
    this.migrationState.progress.entities.total = documents.length;

    // Group documents by type for dependency management
    const documentsByType = this.groupDocumentsByType(documents);

    // Define migration order - dependencies first
    const migrationOrder = [
      "category", // Categories first (no dependencies)
      "person", // People next (no dependencies)
      "product", // Products (may depend on categories)
      "page", // Pages (may depend on various things)
      "post", // Posts last (depend on categories, people)
    ];

    // Migrate in dependency order
    for (const contentType of migrationOrder) {
      const docs = documentsByType[contentType] || [];
      if (docs.length > 0) {
        console.log(`Migrating ${docs.length} ${contentType} documents...`);

        for (let i = 0; i < docs.length; i += this.config.batchSize) {
          const batch = docs.slice(i, i + this.config.batchSize);
          await this.migrateBatch(batch, contentType);

          if (i + this.config.batchSize < docs.length) {
            await this.delay(500);
          }
        }
      }
    }

    // Handle any remaining types not in the order
    for (const [contentType, docs] of Object.entries(documentsByType)) {
      if (!migrationOrder.includes(contentType)) {
        console.log(`Migrating ${docs.length} ${contentType} documents...`);

        for (let i = 0; i < docs.length; i += this.config.batchSize) {
          const batch = docs.slice(i, i + this.config.batchSize);
          await this.migrateBatch(batch, contentType);

          if (i + this.config.batchSize < docs.length) {
            await this.delay(500);
          }
        }
      }
    }
  }

  groupDocumentsByType(documents) {
    const grouped = {};
    for (const doc of documents) {
      if (!grouped[doc._type]) {
        grouped[doc._type] = [];
      }
      grouped[doc._type].push(doc);
    }
    return grouped;
  }

  async migrateBatch(documents, contentType) {
    const promises = documents.map((doc) =>
      this.migrateDocument(doc, contentType)
    );
    await Promise.allSettled(promises);
  }

  async migrateDocument(document, contentType) {
    try {
      console.log(`Migrating ${contentType}: ${document._id}`);

      // Get the Strapi schema for this content type
      const strapiSchema = this.schemaMapping.get(contentType);
      if (!strapiSchema) {
        throw new Error(
          `No Strapi schema found for content type: ${contentType}`
        );
      }

      // Transform document using schema-aware transformation
      const strapiData = await this.transformDocumentWithSchema(
        document,
        strapiSchema,
        contentType
      );

      // Create entity in Strapi
      const response = await this.createStrapiEntity(contentType, strapiData);

      // Extract entity IDs from response
      const entityData = response.data?.data || response.data;
      const entityId = entityData?.id;
      const documentId = entityData?.documentId;

      // Store mapping for relationship resolution
      this.migrationState.entities.set(document._id, {
        strapiId: entityId,
        documentId: documentId,
        contentType,
        originalData: document,
      });

      this.migrationState.progress.entities.completed++;
      console.log(
        `Created ${contentType}: ${document._id} -> ${
          entityId || "NO_ID"
        } (docId: ${documentId || "NO_DOC_ID"})`
      );
    } catch (error) {
      this.migrationState.progress.entities.failed++;
      this.migrationState.errors.push({
        type: "entity",
        contentType,
        id: document._id,
        error: error.message,
        stack: error.stack,
      });
      console.error(
        `Failed to migrate ${contentType} ${document._id}:`,
        error.message
      );
    }
  }

  // NEW: Schema-aware document transformation
  async transformDocumentWithSchema(document, strapiSchema, contentType) {
    const transformed = {};

    // Skip Sanity system fields
    const skipFields = [
      "_id",
      "_type",
      "_rev",
      "_createdAt",
      "_updatedAt",
      "_system",
    ];

    for (const [sanityFieldName, sanityValue] of Object.entries(document)) {
      if (skipFields.includes(sanityFieldName)) continue;

      // Check if this field exists in the Strapi schema
      const strapiFieldConfig = strapiSchema.attributes[sanityFieldName];
      if (!strapiFieldConfig) {
        console.warn(
          `Field ${sanityFieldName} not found in Strapi schema for ${contentType}, skipping`
        );
        continue;
      }

      try {
        const transformedValue = await this.transformFieldWithSchema(
          sanityFieldName,
          sanityValue,
          strapiFieldConfig,
          document,
          contentType
        );

        if (transformedValue !== null && transformedValue !== undefined) {
          transformed[sanityFieldName] = transformedValue;
        }
      } catch (error) {
        console.warn(
          `Failed to transform field ${sanityFieldName}:`,
          error.message
        );
        continue;
      }
    }

    // Handle published state
    if (!transformed.publishedAt && document.publishedAt) {
      transformed.publishedAt = document.publishedAt;
    } else if (!transformed.publishedAt) {
      transformed.publishedAt = new Date().toISOString();
    }

    return transformed;
  }

  // NEW: Schema-aware field transformation
  async transformFieldWithSchema(
    fieldName,
    sanityValue,
    strapiFieldConfig,
    document,
    contentType
  ) {
    if (sanityValue === null || sanityValue === undefined) {
      return null;
    }

    console.log(
      `Transforming field ${fieldName} with Strapi type: ${strapiFieldConfig.type}`
    );

    switch (strapiFieldConfig.type) {
      case "string":
      case "text":
      case "email":
      case "boolean":
      case "integer":
      case "biginteger":
      case "decimal":
      case "float":
      case "date":
      case "datetime":
      case "time":
        return sanityValue;

      case "uid":
        // Handle slug objects
        if (typeof sanityValue === "object" && sanityValue._type === "slug") {
          return sanityValue.current;
        }
        return sanityValue;

      case "media":
        return await this.transformMediaField(sanityValue, strapiFieldConfig);

      case "blocks":
        return this.convertPortableTextToBlocks(sanityValue);

      case "component":
        return await this.transformComponentField(
          sanityValue,
          strapiFieldConfig,
          fieldName,
          document,
          contentType
        );

      case "relation":
        // Store for later relationship processing
        this.storeRelationshipForProcessing(
          contentType,
          document._id,
          fieldName,
          sanityValue,
          strapiFieldConfig
        );
        return null; // Will be populated later

      case "json":
      default:
        return sanityValue;
    }
  }

  // NEW: Transform media fields based on schema config
  async transformMediaField(sanityValue, strapiFieldConfig) {
    const isMultiple = strapiFieldConfig.multiple === true;

    if (Array.isArray(sanityValue)) {
      if (!isMultiple) {
        console.warn("Array value for single media field, taking first item");
        sanityValue = sanityValue[0];
      } else {
        // Transform array of media
        const results = [];
        for (const item of sanityValue) {
          const assetId = this.extractAssetIdFromImage(item);
          if (assetId) {
            const migratedAsset = this.migrationState.assets.get(assetId);
            if (migratedAsset) {
              results.push(migratedAsset.id);
            }
          }
        }
        return results;
      }
    }

    // Handle single media
    const assetId = this.extractAssetIdFromImage(sanityValue);
    if (assetId) {
      const migratedAsset = this.migrationState.assets.get(assetId);
      return migratedAsset ? migratedAsset.id : null;
    }

    return null;
  }

  // NEW: Transform component fields based on schema config
  async transformComponentField(
    sanityValue,
    strapiFieldConfig,
    fieldName,
    document,
    contentType
  ) {
    const componentKey = strapiFieldConfig.component;
    const isRepeatable = strapiFieldConfig.repeatable === true;

    console.log(
      `Transforming component field ${fieldName} with component ${componentKey}`
    );

    if (!this.componentMapping.has(componentKey)) {
      console.warn(`Component ${componentKey} not found in component mapping`);
      return null;
    }

    const componentSchema = this.componentMapping.get(componentKey);

    if (isRepeatable) {
      if (!Array.isArray(sanityValue)) {
        console.warn(
          `Expected array for repeatable component ${componentKey}, got ${typeof sanityValue}`
        );
        return null;
      }

      const results = [];
      for (const item of sanityValue) {
        const transformedItem = await this.transformComponentData(
          item,
          componentSchema
        );
        if (transformedItem !== null) {
          results.push(transformedItem);
        }
      }
      return results;
    } else {
      return await this.transformComponentData(sanityValue, componentSchema);
    }
  }

  // NEW: Transform individual component data
  async transformComponentData(sanityData, componentSchema) {
    if (!sanityData || typeof sanityData !== "object") {
      return null;
    }

    const transformed = {};

    for (const [sanityFieldName, sanityValue] of Object.entries(sanityData)) {
      // Skip Sanity system fields
      if (sanityFieldName.startsWith("_")) continue;

      const componentFieldConfig = componentSchema.attributes[sanityFieldName];
      if (!componentFieldConfig) {
        console.warn(
          `Component field ${sanityFieldName} not found in component schema`
        );
        continue;
      }

      try {
        const transformedValue = await this.transformComponentFieldValue(
          sanityValue,
          componentFieldConfig
        );

        if (transformedValue !== null && transformedValue !== undefined) {
          transformed[sanityFieldName] = transformedValue;
        }
      } catch (error) {
        console.warn(
          `Failed to transform component field ${sanityFieldName}:`,
          error.message
        );
      }
    }

    return Object.keys(transformed).length > 0 ? transformed : null;
  }

  // NEW: Transform component field values
  async transformComponentFieldValue(sanityValue, fieldConfig) {
    if (sanityValue === null || sanityValue === undefined) {
      return null;
    }

    switch (fieldConfig.type) {
      case "string":
      case "text":
      case "boolean":
      case "integer":
      case "decimal":
        return sanityValue;

      case "media":
        const assetId = this.extractAssetIdFromImage(sanityValue);
        if (assetId) {
          const migratedAsset = this.migrationState.assets.get(assetId);
          return migratedAsset ? migratedAsset.id : null;
        }
        return null;

      default:
        return sanityValue;
    }
  }

  // NEW: Store relationship for later processing
  storeRelationshipForProcessing(
    sourceType,
    sourceId,
    fieldName,
    sanityValue,
    strapiFieldConfig
  ) {
    const relation = strapiFieldConfig.relation;
    const isArray = relation.includes("Many") && relation.endsWith("Many");

    if (Array.isArray(sanityValue)) {
      for (const item of sanityValue) {
        if (item._type === "reference" && item._ref) {
          this.migrationState.pendingRelationships.push({
            sourceType,
            sourceId,
            fieldName,
            targetId: item._ref,
            isArray: true,
            relation,
          });
        }
      }
    } else if (sanityValue._type === "reference" && sanityValue._ref) {
      this.migrationState.pendingRelationships.push({
        sourceType,
        sourceId,
        fieldName,
        targetId: sanityValue._ref,
        isArray: false,
        relation,
      });
    }
  }

  // Extract asset ID from Sanity image object
  extractAssetIdFromImage(imageObj) {
    if (imageObj._sanityAsset) {
      return this.extractAssetKey(imageObj._sanityAsset);
    }

    if (imageObj.asset && imageObj.asset._ref) {
      const match = imageObj.asset._ref.match(/image-([a-f0-9]+)-/);
      return match ? match[1] : null;
    }

    return null;
  }

  // Convert Sanity Portable Text to Strapi Blocks (unchanged from original)
  convertPortableTextToBlocks(portableText) {
    if (!Array.isArray(portableText)) return [];

    const blocks = [];
    for (const block of portableText) {
      if (block._type === "block") {
        const strapiBlock = this.convertSanityBlockToStrapiBlock(block);
        if (strapiBlock) {
          blocks.push(strapiBlock);
        }
      }
    }
    return blocks;
  }

  convertSanityBlockToStrapiBlock(sanityBlock) {
    const { style, children, markDefs } = sanityBlock;

    if (style && style.startsWith("h") && style.length === 2) {
      const level = parseInt(style.charAt(1));
      return {
        type: "heading",
        level,
        children: this.convertSpansToStrapiText(children, markDefs),
      };
    }

    if (style === "blockquote") {
      return {
        type: "quote",
        children: this.convertSpansToStrapiText(children, markDefs),
      };
    }

    return {
      type: "paragraph",
      children: this.convertSpansToStrapiText(children, markDefs),
    };
  }

  convertSpansToStrapiText(spans, markDefs = []) {
    if (!spans || !Array.isArray(spans)) return [];

    return spans.map((span) => {
      const textNode = {
        type: "text",
        text: span.text || "",
      };

      if (span.marks && span.marks.length > 0) {
        for (const mark of span.marks) {
          if (mark === "strong") textNode.bold = true;
          if (mark === "em") textNode.italic = true;
          if (mark === "underline") textNode.underline = true;
          if (mark === "strike-through") textNode.strikethrough = true;
          if (mark === "code") textNode.code = true;

          const markDef = markDefs.find((def) => def._key === mark);
          if (markDef && markDef._type === "link") {
            return {
              type: "link",
              url: markDef.href,
              children: [{ type: "text", text: span.text }],
            };
          }
        }
      }

      return textNode;
    });
  }

  // Create entity in Strapi
  async createStrapiEntity(contentType, data) {
    const endpoint = `/api/${this.pluralize(contentType)}`;

    try {
      const response = await this.strapiApi.post(endpoint, { data });
      return response;
    } catch (error) {
      if (error.response) {
        console.error(
          `Strapi API Error (${error.response.status}):`,
          JSON.stringify(error.response.data, null, 2)
        );
        console.error("Request payload:", JSON.stringify({ data }, null, 2));
        throw new Error(
          `API Error: ${error.response.status} - ${JSON.stringify(
            error.response.data
          )}`
        );
      }
      throw error;
    }
  }

  // Process pending relationships (simplified - relationships should be handled by schema-aware transformation)
  async processPendingRelationships() {
    if (this.migrationState.pendingRelationships.length === 0) {
      console.log("No relationships to process");
      return;
    }

    console.log(
      `Processing ${this.migrationState.pendingRelationships.length} relationships...`
    );
    this.migrationState.progress.relationships.total =
      this.migrationState.pendingRelationships.length;

    for (const relationship of this.migrationState.pendingRelationships) {
      try {
        await this.processRelationship(relationship);
        this.migrationState.progress.relationships.completed++;
      } catch (error) {
        this.migrationState.progress.relationships.failed++;
        this.migrationState.errors.push({
          type: "relationship",
          relationship,
          error: error.message,
        });
        console.error(`Failed to process relationship:`, error.message);
      }
    }
  }

  async processRelationship(relationship) {
    const { sourceType, sourceId, fieldName, targetId, isArray } = relationship;

    const sourceEntity = this.migrationState.entities.get(sourceId);
    const targetEntity = this.migrationState.entities.get(targetId);

    if (!sourceEntity || !targetEntity) {
      console.warn(
        `Missing entity for relationship: ${sourceId} -> ${targetId}`
      );
      return;
    }

    const sourceDocumentId = sourceEntity.documentId || sourceEntity.strapiId;
    const targetDocumentId = targetEntity.documentId || targetEntity.strapiId;

    if (!sourceDocumentId || !targetDocumentId) {
      console.warn(
        `Invalid IDs for relationship: ${sourceDocumentId} -> ${targetDocumentId}`
      );
      return;
    }

    try {
      const endpoint = `/api/${this.pluralize(sourceType)}/${sourceDocumentId}`;
      const currentResponse = await this.strapiApi.get(endpoint);
      const currentData = currentResponse.data?.data || currentResponse.data;
      const updateData = { ...currentData };

      if (updateData.attributes) {
        Object.assign(updateData, updateData.attributes);
        delete updateData.attributes;
      }

      if (isArray) {
        if (!Array.isArray(updateData[fieldName])) {
          updateData[fieldName] = [];
        }
        if (!updateData[fieldName].includes(targetDocumentId)) {
          updateData[fieldName].push(targetDocumentId);
        }
      } else {
        updateData[fieldName] = targetDocumentId;
      }

      delete updateData.id;
      delete updateData.documentId;
      delete updateData.createdAt;
      delete updateData.updatedAt;
      delete updateData.publishedAt;

      await this.strapiApi.put(endpoint, { data: updateData });
      console.log(
        `Updated relationship: ${sourceType}.${fieldName} -> ${targetEntity.contentType}`
      );
    } catch (error) {
      console.error(`Failed to process relationship: ${error.message}`);
      throw error;
    }
  }

  // Utility methods
  extractAssetKey(sanityAsset) {
    const match = sanityAsset.match(/images\/([^-]+)/);
    return match ? match[1] : sanityAsset;
  }

  getMimeType(filename) {
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".svg": "image/svg+xml",
      ".webp": "image/webp",
      ".pdf": "application/pdf",
    };
    return mimeTypes[ext] || "application/octet-stream";
  }

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

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Generate migration report
  async generateMigrationReport() {
    const report = {
      migration: {
        timestamp: new Date().toISOString(),
        config: {
          strapiUrl: this.config.strapiUrl,
          assetProvider: this.config.assetProvider,
          batchSize: this.config.batchSize,
        },
        progress: this.migrationState.progress,
        summary: {
          totalAssets: this.migrationState.progress.assets.total,
          migratedAssets: this.migrationState.progress.assets.completed,
          totalEntities: this.migrationState.progress.entities.total,
          migratedEntities: this.migrationState.progress.entities.completed,
          totalRelationships: this.migrationState.progress.relationships.total,
          processedRelationships:
            this.migrationState.progress.relationships.completed,
        },
        errors: this.migrationState.errors,
        entityMappings: Object.fromEntries(this.migrationState.entities),
        assetMappings: Object.fromEntries(this.migrationState.assets),
        schemasUsed: Array.from(this.schemaMapping.keys()),
        componentsUsed: Array.from(this.componentMapping.keys()),
      },
    };

    await fs.writeJSON("universal-migration-report.json", report, {
      spaces: 2,
    });
    console.log("Migration report generated: universal-migration-report.json");
  }

  printSummary() {
    const { progress } = this.migrationState;

    console.log("\nMigration Summary:");
    console.log(
      `Assets: ${progress.assets.completed}/${progress.assets.total} (${progress.assets.failed} failed)`
    );
    console.log(
      `Entities: ${progress.entities.completed}/${progress.entities.total} (${progress.entities.failed} failed)`
    );
    console.log(
      `Relationships: ${progress.relationships.completed}/${progress.relationships.total} (${progress.relationships.failed} failed)`
    );
    console.log(`Total errors: ${this.migrationState.errors.length}`);
    console.log(`Schemas used: ${this.schemaMapping.size}`);
    console.log(`Components used: ${this.componentMapping.size}`);

    if (this.migrationState.errors.length > 0) {
      console.log(
        "\nErrors occurred during migration. Check universal-migration-report.json for details."
      );
    }
  }
}

// CLI runner
async function runMigration() {
  const config = {
    strapiUrl: process.env.STRAPI_URL || "http://localhost:1337",
    apiToken: process.env.STRAPI_API_TOKEN || "your-api-token-here",
    assetProvider: process.env.ASSET_PROVIDER || "strapi",
    strapiProjectPath: process.env.STRAPI_PROJECT_PATH || "../strapi-project",
    cloudinary: {
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    },
  };

  if (!config.apiToken || config.apiToken === "your-api-token-here") {
    console.error("STRAPI_API_TOKEN environment variable is required");
    process.exit(1);
  }

  const sanityExportPath = process.argv[2] || "./sanity-export";

  if (!fs.existsSync(sanityExportPath)) {
    console.error(`Sanity export path not found: ${sanityExportPath}`);
    process.exit(1);
  }

  if (!fs.existsSync(config.strapiProjectPath)) {
    console.error(`Strapi project path not found: ${config.strapiProjectPath}`);
    process.exit(1);
  }

  const migrator = new UniversalContentMigrator(config);

  try {
    await migrator.migrate(sanityExportPath);
    console.log("Migration completed successfully!");
  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  }
}

// Export for use as module
module.exports = UniversalContentMigrator;

// Run if called directly
if (require.main === module) {
  runMigration();
}
