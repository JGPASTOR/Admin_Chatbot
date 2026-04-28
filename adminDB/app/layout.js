import "./globals.css";
import AppShell from "../components/AppShell";

export const metadata = {
  title: "DocTrack Admin — Chatbot AI Document Tracker",
  description: "Admin portal for managing and tracking documents for the chatbot AI system.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "'Inter', sans-serif" }}>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}

