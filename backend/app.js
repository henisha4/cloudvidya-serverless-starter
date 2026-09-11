const crypto = require("crypto");
const {
  DynamoDBClient,
} = require("@aws-sdk/client-dynamodb");
const {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
const { PutObjectCommand, S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const tableName = process.env.TABLE_NAME;
const bucketName = process.env.BUCKET_NAME;
const allowedCategories = new Set([
  "Notes",
  "Past Papers",
  "Study Guides",
  "Assignments",
  "Question Banks",
  "Lab Manuals",
  "E-Books",
  "Other",
]);
const allowedStatuses = new Set(["Available", "Needs review", "Archived"]);

const response = (statusCode, body) => ({
  statusCode,
  headers: {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body),
});

function parseBody(event) {
  if (!event.body) return {};
  return typeof event.body === "string" ? JSON.parse(event.body) : event.body;
}

function validateResource(input, partial = false) {
  const fields = ["title", "description", "category", "course", "semester", "uploadedBy", "status"];
  const resource = {};
  for (const field of fields) {
    if (input[field] !== undefined) resource[field] = String(input[field]).trim();
  }
  if (!partial && (!resource.title || !resource.category || !resource.course)) {
    throw new Error("Title, category, and course are required.");
  }
  if (resource.title && resource.title.length > 160) throw new Error("Title is too long.");
  if (resource.category && !allowedCategories.has(resource.category)) throw new Error("Invalid category.");
  if (resource.status && !allowedStatuses.has(resource.status)) throw new Error("Invalid status.");
  return resource;
}

exports.handler = async (event) => {
  if (event.requestContext?.http?.method === "OPTIONS") return response(204, {});
  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = event.requestContext?.http?.path || event.path || "/";
  const id = event.pathParameters?.id
    || path.match(/^\/items\/([^/]+)$/)?.[1]
    || path.match(/^\/download-url\/([^/]+)$/)?.[1];

  try {
    if (method === "GET" && path === "/items") {
      const result = await dynamo.send(new ScanCommand({ TableName: tableName }));
      const items = (result.Items || []).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return response(200, items);
    }

    if (method === "POST" && path === "/items") {
      const input = validateResource(parseBody(event));
      const item = {
        id: crypto.randomUUID(),
        ...input,
        description: input.description || "",
        semester: input.semester || "",
        uploadedBy: input.uploadedBy || "Student",
        status: input.status || "Available",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await dynamo.send(new PutCommand({ TableName: tableName, Item: item }));
      return response(201, item);
    }

    if (id && method === "GET" && path.startsWith("/download-url/")) {
      const item = await dynamo.send(new GetCommand({ TableName: tableName, Key: { id } }));
      if (!item.Item || !item.Item.fileKey) return response(404, { message: "File not found." });
      const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucketName, Key: item.Item.fileKey }), { expiresIn: 900 });
      return response(200, { url });
    }

    if (id && (method === "PATCH" || method === "DELETE")) {
      if (method === "DELETE") {
        await dynamo.send(new DeleteCommand({ TableName: tableName, Key: { id } }));
        return response(200, { message: "Resource deleted." });
      }
      const input = validateResource(parseBody(event), true);
      if (!Object.keys(input).length) return response(400, { message: "At least one field is required." });
      const names = Object.keys(input).map((key) => `#${key}`);
      const values = Object.keys(input).map((key) => `:${key}`);
      const result = await dynamo.send(new UpdateCommand({
        TableName: tableName,
        Key: { id },
        UpdateExpression: `SET ${names.map((name, index) => `${name} = ${values[index]}`).join(", ")}, #updatedAt = :updatedAt`,
        ExpressionAttributeNames: Object.fromEntries([...Object.keys(input), "updatedAt"].map((key) => [`#${key}`, key])),
        ExpressionAttributeValues: Object.fromEntries([...Object.keys(input), "updatedAt"].map((key) => [`:${key}`, key === "updatedAt" ? new Date().toISOString() : input[key]])),
        ReturnValues: "ALL_NEW",
      }));
      return response(200, result.Attributes);
    }

    if (method === "POST" && path === "/upload-url") {
      const input = parseBody(event);
      if (!input.fileName || !input.fileType) return response(400, { message: "fileName and fileType are required." });
      const safeName = String(input.fileName).replace(/[^a-zA-Z0-9._-]/g, "-");
      const fileKey = `resources/${crypto.randomUUID()}-${safeName}`;
      const uploadUrl = await getSignedUrl(s3, new PutObjectCommand({
        Bucket: bucketName,
        Key: fileKey,
        ContentType: String(input.fileType),
      }), { expiresIn: 900 });
      return response(200, { uploadUrl, fileKey, fileName: String(input.fileName) });
    }

    return response(404, { message: "Route not found." });
  } catch (error) {
    console.error("Request failed", error);
    return response(error.message.includes("required") || error.message.includes("Invalid") || error.message.includes("too long") ? 400 : 500, { message: error.message });
  }
};