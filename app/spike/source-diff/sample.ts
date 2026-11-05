/** A patch as the store's `diff` writes one: a page's Markdown, frontmatter and body. */
export const SAMPLE_PATCH = `--- notes/sample.md@3
+++ notes/sample.md@7
@@ -1,15 +1,16 @@
 ---
 title: Sample
-description: A page to diff.
+description: A page to diff, with a longer description.
 tags: [spike, diff]
 ---
 # Sample
 
-Margin is **revenue** minus cost.[^book]
+Margin is **revenue** minus *cost*, as a share of revenue.[^book]
 
 - one
-- two
+- two, changed
+- three
 
 | a | b |
 | - | - |
 | 1 | 2 |
@@ -20,5 +21,5 @@
 \`\`\`js
-const x = 1;
+const x = 2;
 \`\`\`
 
-[^book]: The book, p. 3.
+[^book]: The book, p. 4.
`;
