import { describe, it, expect } from "vitest";

// Extract the CSP modifier logic as a standalone function for testing.
// In background.js it's inlined in the listener — we replicate the same logic here.
function modifyCSP(headerValue) {
  return headerValue.replace(
    /script-src\s+([^;]*)/i,
    (match, policies) => {
      if (policies.includes("'unsafe-inline'")) return match;
      return `script-src ${policies} 'unsafe-inline'`;
    }
  );
}

describe("CSP modifier", () => {
  it("adds 'unsafe-inline' to script-src", () => {
    const input = "default-src 'self'; script-src 'self' https://cdn.example.com; style-src 'self'";
    const result = modifyCSP(input);
    expect(result).toBe(
      "default-src 'self'; script-src 'self' https://cdn.example.com 'unsafe-inline'; style-src 'self'"
    );
  });

  it("preserves other directives unchanged", () => {
    const input = "default-src 'none'; script-src 'self'; img-src *; style-src 'unsafe-inline'";
    const result = modifyCSP(input);
    expect(result).toContain("default-src 'none'");
    expect(result).toContain("img-src *");
    expect(result).toContain("style-src 'unsafe-inline'");
    expect(result).toContain("script-src 'self' 'unsafe-inline'");
  });

  it("handles missing script-src (no crash, no change)", () => {
    const input = "default-src 'self'; style-src 'self'";
    const result = modifyCSP(input);
    expect(result).toBe(input);
  });

  it("doesn't double-add 'unsafe-inline'", () => {
    const input = "script-src 'self' 'unsafe-inline'; default-src 'none'";
    const result = modifyCSP(input);
    expect(result).toBe(input);
  });

  it("works with complex policy values", () => {
    const input = "script-src 'self' 'nonce-abc123' https://*.spotify.com; object-src 'none'";
    const result = modifyCSP(input);
    expect(result).toBe(
      "script-src 'self' 'nonce-abc123' https://*.spotify.com 'unsafe-inline'; object-src 'none'"
    );
  });
});
