import { Inter } from "next/font/google";
import "./globals.css";
import Sidebar from "../components/Sidebar";

const inter = Inter({ subsets: ["latin"] });

export const metadata = {
  title: "DocTrack Admin — Chatbot AI Document Tracker",
  description: "Admin portal for managing and tracking documents for the chatbot AI system.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: inter.style.fontFamily }}>
        <div style={{ display: 'flex', minHeight: '100vh' }}>
          <Sidebar />
          <div style={{
            marginLeft: 'var(--sidebar-w)',
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            minHeight: '100vh',
            background: 'var(--bg)',
          }}>
            {children}
          </div>
        </div>
      </body>
    </html>
  );
}
