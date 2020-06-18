import { useLocation } from "react-router-dom";
import { useEffect } from "react";

function RouterAnalytics() {
  let location = useLocation();
  useEffect(() => {
    const analytics = window.firebase && window.firebase.analytics;
    if (typeof analytics === "function") {
      const page_path = location.pathname + location.search;
      analytics().setCurrentScreen(page_path);
      analytics().logEvent("page_view", { page_path });
    }
  }, [location]);
  return null;
}

export default RouterAnalytics;
