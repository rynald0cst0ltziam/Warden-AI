/**
 * License feature gating tests.
 *
 * Warden is a single product — one price, all features. No tiers.
 * hasFeature() returns isLicensed() for everything.
 */
import { describe, it, expect } from "vitest";
import { hasFeature, isLicensed } from "../src/license/index.js";

const licensed = isLicensed();

describe("hasFeature", () => {
  it("returns isLicensed() for any feature name", () => {
    // Every feature name should return the same value: isLicensed()
    expect(hasFeature("pruning")).toBe(licensed);
    expect(hasFeature("dashboard")).toBe(licensed);
    expect(hasFeature("file-compression")).toBe(licensed);
    expect(hasFeature("slack-alerts")).toBe(licensed);
    expect(hasFeature("watchdog")).toBe(licensed);
    expect(hasFeature("anything-at-all")).toBe(licensed);
  });

  it("returns the same value for unknown features", () => {
    expect(hasFeature("nonexistent")).toBe(licensed);
    expect(hasFeature("")).toBe(licensed);
  });
});
