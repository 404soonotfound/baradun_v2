import schema from "@baradun/contracts/schema.json";
import type {
  CreateInquiryRequest,
  InquiryUploadRequest,
} from "@baradun/contracts";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const ajv = new Ajv2020({ allErrors: true, strictTypes: false });
addFormats(ajv);
ajv.addSchema(schema);

function validator(definition: string) {
  const check = ajv.getSchema(`${schema.$id}#/$defs/${definition}`);
  if (!check) throw new Error(`계약 정의 없음: ${definition}`);
  return check;
}

const uploadRequest = validator("InquiryUploadRequest");
const createRequest = validator("CreateInquiryRequest");

export function isInquiryUploadRequest(
  value: unknown,
): value is InquiryUploadRequest {
  return uploadRequest(value) as boolean;
}

export function isCreateInquiryRequest(
  value: unknown,
): value is CreateInquiryRequest {
  if (!(createRequest(value) as boolean)) return false;
  const request = value as CreateInquiryRequest;
  if (request.message.trim().length === 0) return false;

  const photoIds = new Set(request.photos.map((photo) => photo.photoId));
  const keys = new Set(request.photos.map((photo) => photo.key));
  return (
    photoIds.size === request.photos.length && keys.size === request.photos.length
  );
}
