import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./index.js";

describe("GET /health", () => {
  it("returns ok status with service metadata", async () => {
    const app = createApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.service).toBe("bond-api");
  });
});
