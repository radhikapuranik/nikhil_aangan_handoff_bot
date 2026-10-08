import { brainHandler } from "../../src/server/bootstrap.ts";
export const POST = (req: Request) => brainHandler()(req);
