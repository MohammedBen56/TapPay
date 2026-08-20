import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { Tabs } from "expo-router";
import * as QuickActions from "expo-quick-actions";
import { useQuickActionRouting, type RouterAction } from "expo-quick-actions/router";
import { useEffect } from "react";
import { StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, type } from "../../src/design/tokens";

type IconName = keyof typeof Ionicons.glyphMap;

function TabIcon({ name, focused }: { name: IconName; focused: boolean }): React.JSX.Element {
  return <Ionicons name={name} size={22} color={focused ? colors.bone : colors.textQuiet} />;
}

export default function TabsLayout(): React.JSX.Element {
  const insets = useSafeAreaInsets();

  // Ship List v2 Wave 2 Phase 2: Android App Shortcuts. This hook must
  // live in a sub-layout route (here, the signed-in tab layout), not the
  // root layout -- it navigates on invocation, and only makes sense once
  // signed in anyway (both shortcut destinations are authed screens).
  useQuickActionRouting();
  useEffect(() => {
    void QuickActions.setItems<RouterAction>([
      { id: "send-money", title: "Send money", icon: "send_money", params: { href: "/(tabs)/send" } },
      { id: "pay-bills", title: "Pay a bill", icon: "pay_bills", params: { href: "/bills" } },
    ]);
  }, []);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.bone,
        tabBarInactiveTintColor: colors.textQuiet,
        tabBarStyle: [styles.bar, { height: 62 + insets.bottom, paddingBottom: insets.bottom }],
        tabBarBackground: () => <BlurView intensity={40} tint="dark" style={StyleSheet.absoluteFill} />,
        tabBarLabelStyle: styles.label,
        tabBarItemStyle: styles.item,
        // Ship List v2 Wave 2 Phase 1 (font-scale audit): the bar's height
        // is a bare constant (62 + inset), not scale-aware -- icon (22) +
        // item padding (4) + bar padding (8) + a scaled label leaves too
        // little headroom at large system font scales. The 3-word label
        // set (Home/Send/Profile) loses little by not scaling; the icons
        // (unaffected by font scale) stay the primary wayfinding signal.
        tabBarAllowFontScaling: false,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: "Home", tabBarIcon: ({ focused }) => <TabIcon name={focused ? "home" : "home-outline"} focused={focused} /> }}
      />
      <Tabs.Screen
        name="send"
        options={{
          title: "Send",
          tabBarIcon: ({ focused }) => <TabIcon name={focused ? "arrow-up-circle" : "arrow-up-circle-outline"} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: "Profile",
          tabBarIcon: ({ focused }) => <TabIcon name={focused ? "person-circle" : "person-circle-outline"} focused={focused} />,
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: "absolute",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.glassBorder,
    backgroundColor: "transparent",
    paddingTop: 8,
  },
  item: { paddingTop: 4 },
  label: { fontFamily: type.bodyStrong.family, fontSize: 11, marginTop: 2 },
});
