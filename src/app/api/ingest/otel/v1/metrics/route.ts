import { handleOtelIngestion } from "@/lib/otel-ingestion";

export async function POST(request: Request) {
  return handleOtelIngestion(request, "metrics");
}
