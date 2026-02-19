import React from "react";
import { Column, Meta } from "@once-ui-system/core";
import { baseURL } from "@/resources";
import StarlinkVisualization from "./StarlinkVisualization";

export async function generateMetadata() {
  return Meta.generate({
    title: "Starlink Tracker - Real-time Satellite Positions",
    description: "Track real-time positions of Starlink satellites using SpaceX API and SGP4 propagation",
    baseURL: baseURL,
    path: "/",
  });
}

export default function Home() {
  return (
    <Column fillWidth gap="l" paddingTop="l">
      <StarlinkVisualization />
    </Column>
  );
}
