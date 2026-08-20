import "../global.css";

import { Newsreader_200ExtraLight, Newsreader_300Light } from "@expo-google-fonts/newsreader";
import {
  SchibstedGrotesk_400Regular,
  SchibstedGrotesk_500Medium,
  SchibstedGrotesk_600SemiBold,
  useFonts,
} from "@expo-google-fonts/schibsted-grotesk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider, useAuth } from "../src/auth/AuthContext";
import { colors } from "../src/design/tokens";

void SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 15_000 } },
});

function RootNavigator(): React.JSX.Element | null {
  const { status } = useAuth();

  useEffect(() => {
    if (status !== "loading") {
      void SplashScreen.hideAsync();
    }
  }, [status]);

  if (status === "loading") return null;

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.ground } }}>
      <Stack.Protected guard={status === "signedIn"}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen
          name="transfer/[txUuid]"
          options={{
            headerShown: true,
            headerTitle: "Transaction",
            headerStyle: { backgroundColor: colors.ground },
            headerTintColor: colors.bone,
            headerShadowVisible: false,
            presentation: "card",
          }}
        />
        <Stack.Screen
          name="bills/index"
          options={{
            headerShown: true,
            headerTitle: "Pay a bill",
            headerStyle: { backgroundColor: colors.ground },
            headerTintColor: colors.bone,
            headerShadowVisible: false,
            presentation: "card",
          }}
        />
        <Stack.Screen
          name="bills/[billerId]"
          options={{
            headerShown: true,
            headerTitle: "Pay bill",
            headerStyle: { backgroundColor: colors.ground },
            headerTintColor: colors.bone,
            headerShadowVisible: false,
            presentation: "card",
          }}
        />
        <Stack.Screen
          name="settings/index"
          options={{
            headerShown: true,
            headerTitle: "Settings",
            headerStyle: { backgroundColor: colors.ground },
            headerTintColor: colors.bone,
            headerShadowVisible: false,
            presentation: "card",
          }}
        />
        <Stack.Screen
          name="settings/change-password"
          options={{
            headerShown: true,
            headerTitle: "Change password",
            headerStyle: { backgroundColor: colors.ground },
            headerTintColor: colors.bone,
            headerShadowVisible: false,
            presentation: "card",
          }}
        />
        <Stack.Screen
          name="settings/sessions"
          options={{
            headerShown: true,
            headerTitle: "Devices",
            headerStyle: { backgroundColor: colors.ground },
            headerTintColor: colors.bone,
            headerShadowVisible: false,
            presentation: "card",
          }}
        />
        <Stack.Screen
          name="statements/index"
          options={{
            headerShown: true,
            headerTitle: "Statements & letters",
            headerStyle: { backgroundColor: colors.ground },
            headerTintColor: colors.bone,
            headerShadowVisible: false,
            presentation: "card",
          }}
        />
        <Stack.Screen
          name="goals/index"
          options={{
            headerShown: true,
            headerTitle: "Goals",
            headerStyle: { backgroundColor: colors.ground },
            headerTintColor: colors.bone,
            headerShadowVisible: false,
            presentation: "card",
          }}
        />
        <Stack.Screen
          name="subscriptions/index"
          options={{
            headerShown: true,
            headerTitle: "Subscriptions",
            headerStyle: { backgroundColor: colors.ground },
            headerTintColor: colors.bone,
            headerShadowVisible: false,
            presentation: "card",
          }}
        />
      </Stack.Protected>
      <Stack.Protected guard={status === "signedOut" || status === "awaitingBiometricPrompt" || status === "locked"}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout(): React.JSX.Element | null {
  const [fontsLoaded] = useFonts({
    Newsreader_200ExtraLight,
    Newsreader_300Light,
    SchibstedGrotesk_400Regular,
    SchibstedGrotesk_500Medium,
    SchibstedGrotesk_600SemiBold,
  });

  if (!fontsLoaded) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.ground }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <RootNavigator />
            <StatusBar style="light" />
          </AuthProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
