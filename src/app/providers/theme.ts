import { createTheme } from "@mui/material/styles";

export const appTheme = createTheme({
  palette: {
    mode: "dark",
    background: {
      default: "#05070d",
      paper: "rgba(13, 18, 31, 0.92)"
    },
    primary: {
      main: "#8cf8ff",
      contrastText: "#031014"
    },
    secondary: {
      main: "#ffcc66",
      contrastText: "#170f02"
    },
    success: {
      main: "#6df7a5"
    },
    warning: {
      main: "#ffcc66"
    },
    error: {
      main: "#ff6b8a"
    },
    divider: "rgba(140, 248, 255, 0.2)",
    text: {
      primary: "#f7fbff",
      secondary: "#a9b7cf"
    }
  },
  typography: {
    fontFamily: '"JetBrains Mono", "SFMono-Regular", Consolas, monospace',
    button: {
      textTransform: "none",
      letterSpacing: 0
    },
    allVariants: {
      letterSpacing: 0
    }
  },
  shape: {
    borderRadius: 8
  },
  components: {
    MuiButtonBase: {
      defaultProps: {
        disableRipple: false
      }
    },
    MuiTooltip: {
      defaultProps: {
        arrow: true
      }
    }
  }
});
