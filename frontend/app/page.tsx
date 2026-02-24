import LivePoll from "./components/LivePoll";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 py-8 sm:p-24 bg-slate-950">
      <div className="z-10 max-w-5xl w-full items-center justify-between font-mono text-sm lg:flex">
        <LivePoll />
      </div>
    </main>
  );
}
