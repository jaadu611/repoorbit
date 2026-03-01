import type { Metadata } from "next";
import "./globals.css";
import Navbar from "@/components/Navbar";

export const metadata: Metadata = {
  title: "RepoOrbit | Visual Repository Intelligence",
  description:
    "An open-source, physics-based explorer to visualize GitHub repository architecture through Chrono-Trees, Complexity Orbits, and Dependency Traces.",
  openGraph: {
    title: "RepoOrbit",
    description: "Visualize the DNA of your codebase.",
    siteName: "RepoOrbit",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Navbar />
        {children}
      </body>
    </html>
  );
}
