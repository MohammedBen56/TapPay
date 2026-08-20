import type { BillerCategory } from "@tappay/shared";
import type { ComponentProps } from "react";
import type { Ionicons } from "@expo/vector-icons";

type IoniconName = ComponentProps<typeof Ionicons>["name"];

/** Single source for how a biller category renders across the biller
 * picker, the pay screen, and TransactionRow's history icon -- three call
 * sites that would otherwise silently drift on label/icon choice. */
export const BILLER_CATEGORY_ICON: Record<BillerCategory, IoniconName> = {
  electricity: "flash-outline",
  water: "water-outline",
  internet: "wifi-outline",
};

export const BILLER_CATEGORY_LABEL: Record<BillerCategory, string> = {
  electricity: "Electricity",
  water: "Water",
  internet: "Internet",
};
