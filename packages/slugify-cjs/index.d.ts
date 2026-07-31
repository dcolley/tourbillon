export interface Options {
  readonly separator?: string;
  readonly lowercase?: boolean;
  readonly decamelize?: boolean;
  readonly customReplacements?: ReadonlyArray<[string, string]>;
  readonly preserveLeadingUnderscore?: boolean;
  readonly preserveTrailingDash?: boolean;
  readonly preserveCharacters?: readonly string[];
}

declare function slugify(string: string, options?: Options): string;
declare function slugifyWithCounter(): (string: string, options?: Options) => string;

export default slugify;
export { slugifyWithCounter };
