declare module "bcryptjs" {
  export function compare(data: string, encrypted: string): Promise<boolean>;
  export function compareSync(data: string, encrypted: string): boolean;

  export function hash(data: string, saltOrRounds: string | number): Promise<string>;
  export function hashSync(data: string, saltOrRounds: string | number): string;

  export function genSalt(rounds?: number): Promise<string>;
  export function genSaltSync(rounds?: number): string;

  const _default: {
    compare?: typeof compare;
    compareSync?: typeof compareSync;
    hash?: typeof hash;
    hashSync?: typeof hashSync;
    genSalt?: typeof genSalt;
    genSaltSync?: typeof genSaltSync;
  };

  export default _default;
}
