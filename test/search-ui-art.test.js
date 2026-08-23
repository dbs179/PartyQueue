import { test } from "node:test";
import assert from "node:assert/strict";
import { searchResultImageHtml } from "../public/js/search-ui.js";

test("searchResultImageHtml uses a sized lazy image", () => {
  const html = searchResultImageHtml("https://i.scdn.co/a.jpg");
  assert.match(html, /width="54"/);
  assert.match(html, /height="54"/);
  assert.match(html, /loading="lazy"/);
  assert.match(html, /decoding="async"/);
  assert.match(html, /https:\/\/i\.scdn\.co\/a\.jpg/);
});

test("searchResultImageHtml eager-loads the first rows", () => {
  const html = searchResultImageHtml("https://i.scdn.co/a.jpg", { eager: true });
  assert.match(html, /loading="eager"/);
});

test("searchResultImageHtml falls back without a src", () => {
  assert.equal(searchResultImageHtml(""), `<div class="art-fallback"></div>`);
  assert.equal(searchResultImageHtml(null), `<div class="art-fallback"></div>`);
});
