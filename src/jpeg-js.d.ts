declare module "jpeg-js" {
  interface Decoded { width: number; height: number; data: Uint8Array }
  const jpeg: {
    decode(b: Buffer, o?: { useTArray?: boolean; maxResolutionInMP?: number; maxMemoryUsageInMB?: number }): Decoded;
    encode(i: { width: number; height: number; data: Buffer }, quality?: number): { data: Buffer };
  };
  export default jpeg;
}
