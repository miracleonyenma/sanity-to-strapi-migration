// migration-scripts/content-migrator.js
const fs = require("fs-extra");
const path = require("path");
const readline = require("readline");
const axios = require("axios");
const FormData = require("form-data");
const { v2: cloudinary } = require("cloudinary");

class ContentMigrator {
  constructor(config = {}) {
    this.config = {
      strapiUrl: config.strapiUrl || "http://localhost:1337",
      apiToken: config.apiToken || "",
      assetProvider: config.assetProvider || "strapi", // 'strapi' or 'cloudinary'
      cloudinary: config.cloudinary || {},
      batchSize: config.batchSize || 10,
      retryAttempts: config.retryAttempts || 3,
      retryDelay: config.retryDelay || 1000,
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

    // API client setup
    this.strapiApi = axios.create({
      baseURL: this.config.strapiUrl,
      headers: {
        Authorization: `Bearer ${this.config.apiToken}`,
        "Content-Type": "application/json",
      },
    });
  }

  // Debug helper method for API responses
  logApiResponse(operation, contentType, id, response) {
    console.log(`🔍 ${operation} ${contentType} ${id}:`);
    console.log(`   Status: ${response.status}`);
    console.log(`   Data structure:`, Object.keys(response.data || {}));

    // Handle different Strapi response formats
    const entityData = response.data?.data || response.data;
    if (entityData) {
      console.log(`   Entity ID: ${entityData.id}`);
      console.log(`   Document ID: ${entityData.documentId}`);
      if (entityData.attributes) {
        console.log(
          `   Has attributes: ${
            Object.keys(entityData.attributes).length
          } fields`
        );
      }
    }
  }

  // Main migration entry point
  async migrate(sanityExportPath) {
    console.log("🚀 Starting Sanity to Strapi content migration...");
    console.log(`📁 Source: ${sanityExportPath}`);
    console.log(`🎯 Target: ${this.config.strapiUrl}`);
    console.log(`📦 Asset provider: ${this.config.assetProvider}`);

    try {
      // Step 1: Load and parse Sanity export data
      const { documents, assets } = await this.loadSanityData(sanityExportPath);
      console.log(
        `📊 Loaded ${documents.length} documents and ${assets.length} assets`
      );

      // Step 2: Migrate assets first
      await this.migrateAssets(assets, sanityExportPath);

      // Step 3: Migrate content in dependency order (categories first, then posts, etc.)
      await this.migrateContent(documents);

      // Step 4: Process pending relationships
      await this.processPendingRelationships();

      // Step 5: Generate migration report
      await this.generateMigrationReport();

      console.log("✅ Migration completed successfully!");
      this.printSummary();
    } catch (error) {
      console.error("💥 Migration failed:", error.message);
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
        console.warn(
          `⚠️ Skipped invalid JSON line: ${line.substring(0, 100)}...`
        );
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
        console.warn("⚠️ Could not load assets.json:", error.message);
      }
    }

    return { documents, assets };
  }

  // Asset migration
  async migrateAssets(assets, exportPath) {
    if (assets.length === 0) {
      console.log("📦 No assets to migrate");
      return;
    }

    console.log(`📦 Migrating ${assets.length} assets...`);
    this.migrationState.progress.assets.total = assets.length;

    const imagesPath = path.join(exportPath, "images");

    for (const asset of assets) {
      try {
        const assetResult = await this.migrateAsset(asset, imagesPath);
        if (assetResult) {
          this.migrationState.assets.set(asset._key, assetResult);
          this.migrationState.progress.assets.completed++;
          console.log(
            `✅ Asset migrated: ${asset.originalFilename} -> ${
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
          `❌ Failed to migrate asset ${asset.originalFilename}:`,
          error.message
        );
      }
    }
  }

  async migrateAsset(asset, imagesPath) {
    const filename = `${asset.sha1hash}-${asset.metadata.dimensions.width}x${asset.metadata.dimensions.height}.png`;
    const filePath = path.join(imagesPath, filename);

    if (!fs.existsSync(filePath)) {
      console.warn(`⚠️ Asset file not found: ${filePath}`);
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

  // Content migration with proper dependency order
  async migrateContent(documents) {
    console.log(`📄 Migrating ${documents.length} documents...`);
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
        console.log(`📝 Migrating ${docs.length} ${contentType} documents...`);

        for (let i = 0; i < docs.length; i += this.config.batchSize) {
          const batch = docs.slice(i, i + this.config.batchSize);
          await this.migrateBatch(batch, contentType);

          // Small delay between batches
          if (i + this.config.batchSize < docs.length) {
            await this.delay(500);
          }
        }
      }
    }

    // Handle any remaining types not in the order
    for (const [contentType, docs] of Object.entries(documentsByType)) {
      if (!migrationOrder.includes(contentType)) {
        console.log(`📝 Migrating ${docs.length} ${contentType} documents...`);

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
      console.log(`🔄 Migrating ${contentType}: ${document._id}`);

      // Transform document to Strapi format
      const strapiData = await this.transformDocument(document, contentType);

      // Create entity in Strapi
      const response = await this.createStrapiEntity(contentType, strapiData);

      // FIXED: Properly extract entity IDs from response
      // Handle both Strapi v4 formats: response.data or response.data.data
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
        `✅ Created ${contentType}: ${document._id} -> ${
          entityId || "NO_ID"
        } (docId: ${documentId || "NO_DOC_ID"})`
      );

      // Add debug logging for problematic responses
      if (!entityId && !documentId) {
        console.warn(`⚠️ No ID returned for ${contentType} ${document._id}:`);
        this.logApiResponse("CREATE", contentType, document._id, response);
      }
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
        `❌ Failed to migrate ${contentType} ${document._id}:`,
        error.message
      );
    }
  }

  async transformDocument(document, contentType) {
    const transformed = {};

    // FIXED: Skip all Sanity system fields including _system
    const skipFields = [
      "_id",
      "_type",
      "_rev",
      "_createdAt",
      "_updatedAt",
      "_system",
    ];

    for (const [key, value] of Object.entries(document)) {
      if (skipFields.includes(key)) continue;

      try {
        const transformedValue = await this.transformField(
          key,
          value,
          document,
          contentType
        );

        // Only include non-null values
        if (transformedValue !== null && transformedValue !== undefined) {
          transformed[key] = transformedValue;
        }
      } catch (error) {
        console.warn(`⚠️ Failed to transform field ${key}:`, error.message);
        // Skip problematic fields rather than storing as fallback
        continue;
      }
    }

    // Handle published state
    if (!transformed.publishedAt && document.publishedAt) {
      transformed.publishedAt = document.publishedAt;
    } else if (!transformed.publishedAt) {
      // Publish by default
      transformed.publishedAt = new Date().toISOString();
    }

    return transformed;
  }

  async transformField(fieldName, fieldValue, document, contentType) {
    if (fieldValue === null || fieldValue === undefined) {
      return null;
    }

    // Handle arrays
    if (Array.isArray(fieldValue)) {
      return await this.transformArray(
        fieldName,
        fieldValue,
        document,
        contentType
      );
    }

    // Handle objects
    if (typeof fieldValue === "object") {
      return await this.transformObject(
        fieldName,
        fieldValue,
        document,
        contentType
      );
    }

    // Handle primitives
    return fieldValue;
  }

  async transformArray(fieldName, arrayValue, document, contentType) {
    // Handle empty arrays
    if (arrayValue.length === 0) {
      return [];
    }

    // Check if this is Portable Text (blocks)
    if (arrayValue.some((item) => item._type === "block")) {
      return this.convertPortableTextToBlocks(arrayValue);
    }

    const transformed = [];

    for (const item of arrayValue) {
      if (typeof item === "object" && item !== null) {
        // Handle references - store for later relationship processing
        if (item._type === "reference" && item._ref) {
          this.migrationState.pendingRelationships.push({
            sourceType: contentType,
            sourceId: document._id,
            fieldName,
            targetId: item._ref,
            isArray: true,
          });
          continue; // Don't add to transformed array now
        }

        // Handle images
        if (item._type === "image") {
          const assetId = this.extractAssetIdFromImage(item);
          if (assetId) {
            const migratedAsset = this.migrationState.assets.get(assetId);
            if (migratedAsset) {
              transformed.push(migratedAsset.id);
            }
          }
          continue;
        }

        // Handle other objects
        const transformedItem = await this.transformObject(
          fieldName,
          item,
          document,
          contentType
        );
        if (transformedItem !== null) {
          transformed.push(transformedItem);
        }
      } else {
        // FIXED: Handle tag arrays - check if this is a tags field and items are strings
        if (fieldName === "tags" && typeof item === "string") {
          // For tags field, we need to handle the relationship with tag entities
          // Store for later relationship processing
          this.migrationState.pendingRelationships.push({
            sourceType: contentType,
            sourceId: document._id,
            fieldName,
            targetId: item, // This is the tag name/value
            isArray: true,
            isTagRelation: true, // Special flag for tag handling
          });
          continue;
        }

        // Handle primitive values
        transformed.push(item);
      }
    }

    return transformed;
  }

  async transformObject(fieldName, objectValue, document, contentType) {
    // Handle slug objects
    if (objectValue._type === "slug") {
      return objectValue.current;
    }

    // Handle image objects
    if (objectValue._type === "image") {
      const assetId = this.extractAssetIdFromImage(objectValue);
      if (assetId) {
        const migratedAsset = this.migrationState.assets.get(assetId);
        return migratedAsset ? migratedAsset.id : null;
      }
      return null;
    }

    // Handle references - store for later relationship processing
    if (objectValue._type === "reference" && objectValue._ref) {
      this.migrationState.pendingRelationships.push({
        sourceType: contentType,
        sourceId: document._id,
        fieldName,
        targetId: objectValue._ref,
        isArray: false,
      });
      return null; // Will be populated later
    }

    // Handle SEO objects - based on your manual example, SEO should be flat
    if (fieldName === "seo") {
      const seoData = {};

      for (const [key, value] of Object.entries(objectValue)) {
        if (!key.startsWith("_")) {
          if (key === "image" && value && value._type === "image") {
            const assetId = this.extractAssetIdFromImage(value);
            if (assetId) {
              const migratedAsset = this.migrationState.assets.get(assetId);
              seoData[key] = migratedAsset ? migratedAsset.id : null;
            }
          } else {
            seoData[key] = value;
          }
        }
      }

      return seoData;
    }

    // For other objects, transform to flat structure (avoid __component)
    const transformed = {};
    for (const [key, value] of Object.entries(objectValue)) {
      if (!key.startsWith("_")) {
        const transformedValue = await this.transformField(
          key,
          value,
          document,
          contentType
        );
        if (transformedValue !== null && transformedValue !== undefined) {
          transformed[key] = transformedValue;
        }
      }
    }

    return Object.keys(transformed).length > 0 ? transformed : null;
  }

  // Extract asset ID from Sanity image object
  extractAssetIdFromImage(imageObj) {
    if (imageObj._sanityAsset) {
      return this.extractAssetKey(imageObj._sanityAsset);
    }

    if (imageObj.asset && imageObj.asset._ref) {
      // Extract from asset reference like "image-abc123-1920x1080-png"
      const match = imageObj.asset._ref.match(/image-([a-f0-9]+)-/);
      return match ? match[1] : null;
    }

    return null;
  }

  // Convert Sanity Portable Text to Strapi Blocks
  convertPortableTextToBlocks(portableText) {
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

    // Handle headings
    if (style && style.startsWith("h") && style.length === 2) {
      const level = parseInt(style.charAt(1));
      return {
        type: "heading",
        level,
        children: this.convertSpansToStrapiText(children, markDefs),
      };
    }

    // Handle blockquote
    if (style === "blockquote") {
      return {
        type: "quote",
        children: this.convertSpansToStrapiText(children, markDefs),
      };
    }

    // Handle normal paragraphs
    if (style === "normal" || !style) {
      const strapiChildren = this.convertSpansToStrapiText(children, markDefs);

      return {
        type: "paragraph",
        children: strapiChildren,
      };
    }

    // Fallback to paragraph
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

      // Apply marks
      if (span.marks && span.marks.length > 0) {
        for (const mark of span.marks) {
          // Handle simple marks
          if (mark === "strong") textNode.bold = true;
          if (mark === "em") textNode.italic = true;
          if (mark === "underline") textNode.underline = true;
          if (mark === "strike-through") textNode.strikethrough = true;
          if (mark === "code") textNode.code = true;

          // Handle complex marks (links)
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

  // FIXED: Process pending relationships after all entities are created
  async processPendingRelationships() {
    if (this.migrationState.pendingRelationships.length === 0) {
      console.log("🔗 No relationships to process");
      return;
    }

    console.log(
      `🔗 Processing ${this.migrationState.pendingRelationships.length} relationships...`
    );
    this.migrationState.progress.relationships.total =
      this.migrationState.pendingRelationships.length;

    for (const relationship of this.migrationState.pendingRelationships) {
      try {
        // FIXED: Skip tag relationships for now since they need special handling
        if (relationship.isTagRelation) {
          console.warn(
            `⚠️ Skipping tag relationship - needs manual setup: ${relationship.sourceType}.${relationship.fieldName} -> ${relationship.targetId}`
          );
          this.migrationState.progress.relationships.completed++;
          continue;
        }

        await this.processRelationship(relationship);
        this.migrationState.progress.relationships.completed++;
      } catch (error) {
        this.migrationState.progress.relationships.failed++;
        this.migrationState.errors.push({
          type: "relationship",
          relationship,
          error: error.message,
        });
        console.error(`❌ Failed to process relationship:`, error.message);
      }
    }
  }

  async processRelationship(relationship) {
    const { sourceType, sourceId, fieldName, targetId, isArray } = relationship;

    // Find source and target entities
    const sourceEntity = this.migrationState.entities.get(sourceId);
    const targetEntity = this.migrationState.entities.get(targetId);

    if (!sourceEntity || !targetEntity) {
      console.warn(
        `⚠️ Missing entity for relationship: ${sourceId} -> ${targetId}`
      );
      return;
    }

    // Use documentId if available, otherwise fall back to strapiId
    const sourceDocumentId = sourceEntity.documentId || sourceEntity.strapiId;
    const targetDocumentId = targetEntity.documentId || targetEntity.strapiId;

    // FIXED: Validate IDs before making API calls
    if (
      !sourceDocumentId ||
      sourceDocumentId === "undefined" ||
      sourceDocumentId === undefined
    ) {
      console.warn(
        `⚠️ Invalid source ID for relationship: ${sourceType}/${sourceId} -> ${sourceDocumentId}`
      );
      return;
    }

    if (
      !targetDocumentId ||
      targetDocumentId === "undefined" ||
      targetDocumentId === undefined
    ) {
      console.warn(
        `⚠️ Invalid target ID for relationship: ${targetEntity.contentType}/${targetId} -> ${targetDocumentId}`
      );
      return;
    }

    try {
      // Get current entity data
      const endpoint = `/api/${this.pluralize(sourceType)}/${sourceDocumentId}`;
      const currentResponse = await this.strapiApi.get(endpoint);

      // Handle different response formats
      const currentData = currentResponse.data?.data || currentResponse.data;

      // Update with relationship
      const updateData = { ...currentData };

      // Remove nested data structure if present
      if (updateData.attributes) {
        Object.assign(updateData, updateData.attributes);
        delete updateData.attributes;
      }

      if (isArray) {
        if (!Array.isArray(updateData[fieldName])) {
          updateData[fieldName] = [];
        }

        // Avoid duplicates
        if (!updateData[fieldName].includes(targetDocumentId)) {
          updateData[fieldName].push(targetDocumentId);
        }
      } else {
        updateData[fieldName] = targetDocumentId;
      }

      // Remove system fields that shouldn't be updated
      delete updateData.id;
      delete updateData.documentId;
      delete updateData.createdAt;
      delete updateData.updatedAt;
      delete updateData.publishedAt;

      // Send update
      await this.strapiApi.put(endpoint, { data: updateData });

      console.log(
        `✅ Updated relationship: ${sourceType}.${fieldName} -> ${targetEntity.contentType}`
      );
    } catch (error) {
      console.error(`Failed to process relationship: ${error.message}`);
      throw error;
    }
  }

  // Utility methods
  extractAssetKey(sanityAsset) {
    // Extract key from _sanityAsset reference like "image@file://./images/filename.png"
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
      },
    };

    await fs.writeJSON("migration-report.json", report, { spaces: 2 });
    console.log("📋 Migration report generated: migration-report.json");
  }

  printSummary() {
    const { progress } = this.migrationState;

    console.log("\n🎉 Migration Summary:");
    console.log(
      `📦 Assets: ${progress.assets.completed}/${progress.assets.total} (${progress.assets.failed} failed)`
    );
    console.log(
      `📄 Entities: ${progress.entities.completed}/${progress.entities.total} (${progress.entities.failed} failed)`
    );
    console.log(
      `🔗 Relationships: ${progress.relationships.completed}/${progress.relationships.total} (${progress.relationships.failed} failed)`
    );
    console.log(`❌ Total errors: ${this.migrationState.errors.length}`);

    if (this.migrationState.errors.length > 0) {
      console.log(
        "\n⚠️ Errors occurred during migration. Check migration-report.json for details."
      );
    }
  }
}

// CLI runner
async function runMigration() {
  const config = {
    strapiUrl: process.env.STRAPI_URL || "http://localhost:1337",
    apiToken:
      process.env.STRAPI_API_TOKEN ||
      "9bf38bf1e938c3e820fb04b9d81262b8b97f052e9959692c10455c805e410aeb697ae2096f94da052a802c45ba039bfea0aacb042b81ebacf3f5cd8cc1bb9c1c0efada0a23253b4e1883131793e5a000d0581adcf9ce2e3408e3ef686eb2731fd8d6471e7ca7c571bb9d33968192274de35828e9f3dabffd04aef04c93b24ed6",
    assetProvider: process.env.ASSET_PROVIDER || "strapi", // 'strapi' or 'cloudinary'
    cloudinary: {
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    },
  };

  if (!config.apiToken) {
    console.error("❌ STRAPI_API_TOKEN environment variable is required");
    process.exit(1);
  }

  const sanityExportPath = process.argv[2] || "./sanity-export";

  if (!fs.existsSync(sanityExportPath)) {
    console.error(`❌ Sanity export path not found: ${sanityExportPath}`);
    process.exit(1);
  }

  const migrator = new ContentMigrator(config);

  try {
    await migrator.migrate(sanityExportPath);
    console.log("🎊 Migration completed successfully!");
  } catch (error) {
    console.error("💥 Migration failed:", error);
    process.exit(1);
  }
}

// Export for use as module
module.exports = ContentMigrator;

// Run if called directly
if (require.main === module) {
  runMigration();
}
