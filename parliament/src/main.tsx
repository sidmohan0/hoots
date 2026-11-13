import React from "react";
import { createRoot } from "react-dom/client";
import { themeCss } from "./tokens";
import "./fonts/fonts.css";
import "./app.css";
import { App } from "./App";

const style = document.createElement("style");
style.textContent = themeCss;
document.head.appendChild(style);

createRoot(document.getElementById("root")!).render(<App />);
