export function wasCliFlagProvided(argv: readonly string[], flag: string): boolean {
  return argv.some((argument) => argument === flag || argument.startsWith(`${flag}=`))
}
