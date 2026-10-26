const INQUIRY_MAX_BODY_BYTES = 32 * 1024;

export const inquiryRequestGuardCode = `
function response(message) {
  return {
    statusCode: 400,
    statusDescription: "Bad Request",
    headers: {
      "content-type": { value: "application/json; charset=utf-8" },
      "cache-control": { value: "no-store" }
    },
    body: JSON.stringify({
      error: { code: "invalid_request", message: message }
    })
  };
}

function handler(event) {
  var request = event.request;
  if (request.method !== "POST") {
    return response("POST 요청만 받을 수 있습니다.");
  }
  if (request.uri !== "/api/inquiries" && request.uri !== "/api/inquiries/uploads") {
    return response("지원하지 않는 요청입니다.");
  }

  var contentType = request.headers["content-type"];
  var contentLength = request.headers["content-length"];
  var payloadHash = request.headers["x-amz-content-sha256"];
  if (!contentType || contentType.value.toLowerCase().split(";", 1)[0] !== "application/json") {
    return response("JSON 요청만 받을 수 있습니다.");
  }
  if (!contentLength || !/^[0-9]+$/.test(contentLength.value)) {
    return response("요청 크기를 확인할 수 없습니다.");
  }
  var length = Number(contentLength.value);
  if (length < 1 || length > ${INQUIRY_MAX_BODY_BYTES}) {
    return response("요청 본문이 너무 큽니다.");
  }
  if (!payloadHash || !/^[0-9a-fA-F]{64}$/.test(payloadHash.value)) {
    return response("요청 본문 해시가 필요합니다.");
  }
  return request;
}
`;
