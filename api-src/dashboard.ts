import { dashboardHandler } from "../src/server/bootstrap.ts";
export async function GET(req: Request) { return (await dashboardHandler())(req); }
