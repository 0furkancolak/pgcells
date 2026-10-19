/** `import m from "./x.sql" with { type: "text" }` (generated migration list): the file content is text. */
declare module "*.sql" {
  const source: string;
  export default source;
}
