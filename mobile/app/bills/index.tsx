import type { BillerCategory } from "@tappay/shared";
import { Ionicons } from "@expo/vector-icons";
import { FlashList } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { billersQueryOptions } from "../../src/api/queries";
import { Card } from "../../src/components/Card";
import { ScreenBackground } from "../../src/components/ScreenBackground";
import { SegmentedControl } from "../../src/components/SegmentedControl";
import { BILLER_CATEGORY_ICON, BILLER_CATEGORY_LABEL } from "../../src/design/billerCategory";
import { colors, type } from "../../src/design/tokens";

type CategoryFilter = "all" | BillerCategory;

const FILTER_OPTIONS: { value: CategoryFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "electricity", label: "Electricity" },
  { value: "water", label: "Water" },
  { value: "internet", label: "Internet" },
];

export default function BillersScreen(): React.JSX.Element {
  const [filter, setFilter] = useState<CategoryFilter>("all");
  const billersQuery = useQuery(billersQueryOptions(filter === "all" ? undefined : filter));
  const billers = billersQuery.data?.billers ?? [];

  return (
    <ScreenBackground>
      <View style={styles.container}>
        <SegmentedControl options={FILTER_OPTIONS} value={filter} onChange={setFilter} />

        <FlashList
          data={billers}
          keyExtractor={(b) => b.id}
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push({ pathname: "/bills/[billerId]", params: { billerId: item.id } })}
            >
              <Card style={styles.billerCard}>
                <View style={styles.iconWrap}>
                  <Ionicons name={BILLER_CATEGORY_ICON[item.category]} size={22} color={colors.bone} />
                </View>
                <View style={styles.billerMiddle}>
                  <Text style={styles.billerName}>{item.name}</Text>
                  <Text style={styles.billerCategory}>{BILLER_CATEGORY_LABEL[item.category]}</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
              </Card>
            </Pressable>
          )}
          contentContainerStyle={styles.listContent}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          ListEmptyComponent={
            billersQuery.isLoading ? (
              <View style={styles.empty}>
                <ActivityIndicator color={colors.textTertiary} />
              </View>
            ) : (
              <Animated.View entering={FadeIn.duration(300)} style={styles.empty}>
                <Ionicons name="receipt-outline" size={28} color={colors.textTertiary} />
                <Text style={styles.emptyText}>No billers found</Text>
              </Animated.View>
            )
          }
        />
      </View>
    </ScreenBackground>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 20, paddingTop: 12, gap: 16 },
  listContent: { paddingBottom: 40 },
  separator: { height: 10 },
  billerCard: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 16 },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.glassLow,
  },
  billerMiddle: { flex: 1, gap: 2 },
  billerName: { fontFamily: type.bodyStrong.family, fontSize: 15, color: colors.bone },
  billerCategory: { fontFamily: type.caption.family, fontSize: 12, color: colors.textQuiet },
  empty: { alignItems: "center", gap: 8, paddingTop: 48 },
  emptyText: { fontFamily: type.bodyStrong.family, fontSize: 15, color: colors.bone },
});
