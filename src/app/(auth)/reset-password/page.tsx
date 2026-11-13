import { AuthFrame } from "@/components/auth-form";
export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const params = await searchParams;
  return <AuthFrame mode="reset" token={params.token} />;
}
