// Snapshot of demo-api/openapi.yaml (hash 62bb4857f9993c5d). Regenerated with the tests.
export const spec: any = {
  "openapi": "3.0.3",
  "info": {
    "title": "Inventory Demo API",
    "version": "1.0.0",
    "description": "Small in-memory API used to demonstrate api-test-agent. It contains one deliberate contract mismatch (GET /stats) and two operations that are intentionally hard to test (admin auth, report without schema).\n",
    "license": {
      "name": "MIT",
      "url": "https://opensource.org/licenses/MIT"
    }
  },
  "servers": [
    {
      "url": "http://localhost:3100"
    }
  ],
  "security": [],
  "tags": [
    {
      "name": "items",
      "description": "Inventory items"
    },
    {
      "name": "ops",
      "description": "Service operations"
    }
  ],
  "paths": {
    "/health": {
      "get": {
        "operationId": "getHealth",
        "summary": "Liveness check",
        "tags": [
          "ops"
        ],
        "responses": {
          "200": {
            "description": "Service is up",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "required": [
                    "status"
                  ],
                  "properties": {
                    "status": {
                      "type": "string",
                      "enum": [
                        "ok"
                      ]
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "/items": {
      "get": {
        "operationId": "listItems",
        "summary": "List items",
        "tags": [
          "items"
        ],
        "parameters": [
          {
            "name": "limit",
            "in": "query",
            "required": false,
            "schema": {
              "type": "integer",
              "minimum": 1,
              "maximum": 100,
              "default": 20
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Items page",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "required": [
                    "items",
                    "total"
                  ],
                  "properties": {
                    "items": {
                      "type": "array",
                      "items": {
                        "$ref": "#/components/schemas/Item"
                      }
                    },
                    "total": {
                      "type": "integer",
                      "minimum": 0
                    }
                  }
                }
              }
            }
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          }
        }
      },
      "post": {
        "operationId": "createItem",
        "summary": "Create an item",
        "tags": [
          "items"
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/ItemInput"
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Created",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Item"
                }
              }
            },
            "links": {
              "GetItem": {
                "operationId": "getItem",
                "parameters": {
                  "itemId": "$response.body#/id"
                }
              },
              "UpdateItem": {
                "operationId": "updateItem",
                "parameters": {
                  "itemId": "$response.body#/id"
                }
              },
              "DeleteItem": {
                "operationId": "deleteItem",
                "parameters": {
                  "itemId": "$response.body#/id"
                }
              }
            }
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          }
        }
      }
    },
    "/items/{itemId}": {
      "parameters": [
        {
          "name": "itemId",
          "in": "path",
          "required": true,
          "schema": {
            "type": "string",
            "format": "uuid"
          }
        }
      ],
      "get": {
        "operationId": "getItem",
        "summary": "Get one item",
        "tags": [
          "items"
        ],
        "responses": {
          "200": {
            "description": "The item",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Item"
                }
              }
            }
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        }
      },
      "patch": {
        "operationId": "updateItem",
        "summary": "Partially update an item",
        "tags": [
          "items"
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/ItemPatch"
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Updated item",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Item"
                }
              }
            }
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        }
      },
      "delete": {
        "operationId": "deleteItem",
        "summary": "Delete an item",
        "tags": [
          "items"
        ],
        "responses": {
          "204": {
            "description": "Deleted"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        }
      }
    },
    "/stats": {
      "get": {
        "operationId": "getStats",
        "summary": "Inventory statistics",
        "tags": [
          "ops"
        ],
        "responses": {
          "200": {
            "description": "Totals",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "required": [
                    "total",
                    "totalValue"
                  ],
                  "properties": {
                    "total": {
                      "type": "integer"
                    },
                    "totalValue": {
                      "type": "number"
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "/reports/{reportId}": {
      "get": {
        "operationId": "getReport",
        "summary": "Download a stored report",
        "tags": [
          "ops"
        ],
        "parameters": [
          {
            "name": "reportId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Report payload (shape not documented)",
            "content": {
              "application/json": {}
            }
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        }
      }
    },
    "/admin/reset": {
      "post": {
        "operationId": "resetInventory",
        "summary": "Delete all items",
        "tags": [
          "ops"
        ],
        "security": [
          {
            "bearerAuth": []
          }
        ],
        "responses": {
          "204": {
            "description": "Inventory cleared"
          },
          "401": {
            "$ref": "#/components/responses/Unauthorized"
          }
        }
      }
    }
  },
  "components": {
    "securitySchemes": {
      "bearerAuth": {
        "type": "http",
        "scheme": "bearer"
      }
    },
    "responses": {
      "BadRequest": {
        "description": "Invalid input",
        "content": {
          "application/json": {
            "schema": {
              "$ref": "#/components/schemas/Error"
            }
          }
        }
      },
      "NotFound": {
        "description": "Not found",
        "content": {
          "application/json": {
            "schema": {
              "$ref": "#/components/schemas/Error"
            }
          }
        }
      },
      "Unauthorized": {
        "description": "Missing or invalid token",
        "content": {
          "application/json": {
            "schema": {
              "$ref": "#/components/schemas/Error"
            }
          }
        }
      }
    },
    "schemas": {
      "ItemInput": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "name",
          "price"
        ],
        "properties": {
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 100,
            "example": "Mechanical keyboard"
          },
          "price": {
            "type": "number",
            "minimum": 0,
            "example": 89.9
          },
          "tags": {
            "type": "array",
            "maxItems": 10,
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 30
            },
            "example": [
              "hardware"
            ]
          }
        }
      },
      "ItemPatch": {
        "type": "object",
        "additionalProperties": false,
        "minProperties": 1,
        "properties": {
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 100,
            "example": "Mechanical keyboard v2"
          },
          "price": {
            "type": "number",
            "minimum": 0,
            "example": 99.5
          },
          "tags": {
            "type": "array",
            "maxItems": 10,
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 30
            }
          }
        }
      },
      "Item": {
        "type": "object",
        "required": [
          "id",
          "name",
          "price",
          "tags",
          "createdAt"
        ],
        "properties": {
          "id": {
            "type": "string",
            "format": "uuid"
          },
          "name": {
            "type": "string"
          },
          "price": {
            "type": "number"
          },
          "tags": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "createdAt": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "Error": {
        "type": "object",
        "required": [
          "message"
        ],
        "properties": {
          "message": {
            "type": "string"
          }
        }
      }
    }
  }
};
