// Bun inlines `import x from './file.md' with { type: 'text' }` at bundle
// time; TypeScript needs to be told the shape.
declare module '*.md' {
  const text: string
  export default text
}

declare module '*.svg' {
  const text: string
  export default text
}
