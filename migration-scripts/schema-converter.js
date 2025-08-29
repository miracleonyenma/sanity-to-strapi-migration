// ./migration-scripts/schema-converter.js
const fs = require("fs-extra");

class SchemaConverter {
  constructor() {
    this.typeMapping = {
      string: "string",
      text: "text",
      number: "integer",
      boolean: "boolean",
      datetime: "datetime",
      date: "date",
      email: "email",
      url: "string",
      slug: "uid",
      image: "media",
      file: "media",
      reference: "relation",
      array: this.handleArrayType.bind(this),
      object: "component",
      block: "richtext",
    };
  }

  // Convert our example schemas
  convertExampleSchemas() {
    const schemas = {
      post: this.convertPostSchema(),
      person: this.convertPersonSchema(),
      category: this.convertCategorySchema(),
      page: this.convertPageSchema(),
      product: this.convertProductSchema(),
    };

    return schemas;
  }

  convertPostSchema() {
    return {
      kind: "collectionType",
      collectionName: "posts",
      info: {
        singularName: "post",
        pluralName: "posts",
        displayName: "Post",
      },
      options: {
        draftAndPublish: true,
      },
      attributes: {
        title: {
          type: "string",
          required: true,
        },
        slug: {
          type: "uid",
          targetField: "title",
          required: true,
        },
        publishedAt: {
          type: "datetime",
          required: true,
        },
        authors: {
          type: "relation",
          relation: "manyToMany",
          target: "api::person.person",
        },
        categories: {
          type: "relation",
          relation: "manyToMany",
          target: "api::category.category",
        },
        image: {
          type: "media",
          multiple: false,
          required: false,
          allowedTypes: ["images"],
        },
        body: {
          type: "richtext",
        },
      },
    };
  }

  convertPersonSchema() {
    return {
      kind: "collectionType",
      collectionName: "people",
      info: {
        singularName: "person",
        pluralName: "people",
        displayName: "Person",
      },
      options: {
        draftAndPublish: true,
      },
      attributes: {
        name: {
          type: "string",
          required: true,
        },
        email: {
          type: "email",
        },
        bio: {
          type: "richtext",
        },
        profilePicture: {
          type: "media",
          multiple: false,
          required: false,
          allowedTypes: ["images"],
        },
      },
    };
  }

  convertCategorySchema() {
    return {
      kind: "collectionType",
      collectionName: "categories",
      info: {
        singularName: "category",
        pluralName: "categories",
        displayName: "Category",
      },
      options: {
        draftAndPublish: true,
      },
      attributes: {
        title: {
          type: "string",
          required: true,
        },
        slug: {
          type: "uid",
          targetField: "title",
        },
      },
    };
  }

  convertPageSchema() {
    return {
      kind: "collectionType",
      collectionName: "pages",
      info: {
        singularName: "page",
        pluralName: "pages",
        displayName: "Page",
      },
      options: {
        draftAndPublish: true,
      },
      attributes: {
        title: {
          type: "string",
          required: true,
        },
        slug: {
          type: "uid",
          targetField: "title",
        },
        body: {
          type: "richtext",
        },
        seo: {
          type: "component",
          repeatable: false,
          component: "seo.seo-component",
        },
      },
    };
  }

  convertProductSchema() {
    return {
      kind: "collectionType",
      collectionName: "products",
      info: {
        singularName: "product",
        pluralName: "products",
        displayName: "Product",
      },
      options: {
        draftAndPublish: true,
      },
      attributes: {
        name: {
          type: "string",
          required: true,
        },
        price: {
          type: "decimal",
          min: 0,
        },
        available: {
          type: "boolean",
          default: true,
        },
        tags: {
          type: "json",
        },
        gallery: {
          type: "media",
          multiple: true,
          required: false,
          allowedTypes: ["images"],
        },
        specifications: {
          type: "component",
          repeatable: false,
          component: "product.specifications",
        },
      },
    };
  }

  async generateStrapiSchemas() {
    const schemas = this.convertExampleSchemas();

    // Generate schema files for each type
    for (const [typeName, schema] of Object.entries(schemas)) {
      const schemaDir = `../strapi-project/src/api/${typeName}/content-types/${typeName}`;
      await fs.ensureDir(schemaDir);
      await fs.writeJSON(`${schemaDir}/schema.json`, schema, { spaces: 2 });

      console.log(`Generated schema for: ${typeName}`);
    }

    // Generate components
    await this.generateComponents();
  }

  async generateComponents() {
    // SEO Component for pages
    const seoComponent = {
      collectionName: "components_seo_seo_components",
      info: {
        displayName: "SEO",
        icon: "search",
      },
      options: {},
      attributes: {
        title: {
          type: "string",
        },
        description: {
          type: "text",
        },
        image: {
          type: "media",
          multiple: false,
          required: false,
          allowedTypes: ["images"],
        },
      },
    };

    // Product Specifications Component
    const specificationsComponent = {
      collectionName: "components_product_specifications",
      info: {
        displayName: "Specifications",
        icon: "bulletList",
      },
      options: {},
      attributes: {
        weight: {
          type: "string",
        },
        dimensions: {
          type: "string",
        },
        material: {
          type: "string",
        },
      },
    };

    // Create component directories and files
    const seoDir = "../strapi-project/src/components/seo";
    const productDir = "../strapi-project/src/components/product";

    await fs.ensureDir(seoDir);
    await fs.ensureDir(productDir);

    await fs.writeJSON(`${seoDir}/seo-component.json`, seoComponent, {
      spaces: 2,
    });
    await fs.writeJSON(
      `${productDir}/specifications.json`,
      specificationsComponent,
      { spaces: 2 }
    );

    console.log("Generated component schemas");
  }
}

// Usage
const converter = new SchemaConverter();
converter.generateStrapiSchemas();
