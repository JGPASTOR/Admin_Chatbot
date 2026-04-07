import { Inter } from "next/font/google";
import "./globals.css";
import AppShell from "../components/AppShell";

const inter = Inter({ subsets: ["latin"] });

export const metadata = {
  title: "DocTrack Admin — Chatbot AI Document Tracker",
  description: "Admin portal for managing and tracking documents for the chatbot AI system.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: inter.style.fontFamily }}>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
