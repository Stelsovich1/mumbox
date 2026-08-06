import { CssBaseline, ThemeProvider } from "@mui/material";

import { BoardPage } from "../pages/board";
import { appTheme } from "./providers/theme";
import "./styles/global.css";

export function App() {
  return (
    <ThemeProvider theme={appTheme}>
      <CssBaseline />
      <BoardPage />
    </ThemeProvider>
  );
}
