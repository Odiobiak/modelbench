import { useEffect, useRef, useState } from "react";
import { subscribeToast } from "../toast";

export default function ToastHost() {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeToast((msg) => {
      setMessage(msg);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setMessage(null), 2400);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  return <div className={`toast${message ? " show" : ""}`}>{message}</div>;
}
