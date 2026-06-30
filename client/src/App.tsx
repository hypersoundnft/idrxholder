import { useState, useEffect, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { ChainCard } from "@/components/ChainCard"
import type { ApiResponse } from "@/types"
import { CHAINS, fetchHolders } from "@/lib/chains"

function App() {
  const [data, setData] = useState<ApiResponse | null>(null)
  const [lastUpdated, setLastUpdated] = useState("—")
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    setLastUpdated("fetching…")
    try {
      const d = await fetchHolders()
      setData(d)
      setLastUpdated(new Date().toLocaleTimeString())
    } catch (err) {
      setLastUpdated("error — " + (err instanceof Error ? err.message : "unknown"))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  return (
    <div className="min-h-screen bg-background text-foreground p-6">
      <div className="max-w-[1600px] mx-auto">
        <header className="flex justify-between items-center mb-6 flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold">
              IDRX <span className="text-primary">Top Holders</span>
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Last updated: {lastUpdated}
            </p>
          </div>
          <Button onClick={refresh} disabled={loading} variant="outline" size="sm">
            {loading ? (
              <>
                <Spinner className="mr-1.5" />
                Loading…
              </>
            ) : (
              "Refresh"
            )}
          </Button>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {CHAINS.map(chain => {
            const state = data?.[chain.id] ?? "loading"
            return <ChainCard key={chain.id} chain={chain} state={state} />
          })}
        </div>

        <footer className="mt-6 text-center text-xs text-muted-foreground">
          IDRX Dashboard — Data from public RPCs, Blockscout, and Solana RPC
        </footer>
      </div>
    </div>
  )
}

export default App
