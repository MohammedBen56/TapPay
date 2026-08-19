/** Whether the Home screen shows the real balance or `••••••` -- a UI
 * preference, not sensitive data, but stored so it survives an app restart
 * (plan "elegant-hopping-lark" M4: "eye toggle whose state persists"). Plain
 * SecureStore key, no authentication gate -- same storage mechanism as the
 * customer-id convenience field in src/auth/secureStore.ts, just a
 * different sensitivity tier. */
import * as SecureStore from "expo-secure-store";

const KEY = "tappay.balanceVisible";

export async function getBalanceVisible(): Promise<boolean> {
  const raw = await SecureStore.getItemAsync(KEY);
  return raw === "1";
}

export async function setBalanceVisible(visible: boolean): Promise<void> {
  await SecureStore.setItemAsync(KEY, visible ? "1" : "0");
}
