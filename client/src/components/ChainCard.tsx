import {
  Card, CardHeader, CardTitle, CardAction, CardContent,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import type { ChainConfig, ChainResult } from "@/types"
import { CHAIN_LABELS, truncate, formatBal } from "@/lib/chains"

interface Props {
  chain: ChainConfig
  state: ChainResult | 'loading'
}

export function ChainCard({ chain, state }: Props) {
  if (state === 'loading') {
    return (
      <Card size="sm">
        <CardHeader>
          <CardTitle>{chain.name}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 py-8 justify-center text-muted-foreground">
            <Spinner />
            <span className="text-sm">Loading…</span>
          </div>
        </CardContent>
      </Card>
    )
  }

  const { holders, error } = state

  if (error) {
    return (
      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-red-400">{chain.name}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="py-6 text-center">
            <p className="text-sm text-muted-foreground">⚠ {error.slice(0, 80)}</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (!holders || holders.length === 0) {
    return (
      <Card size="sm">
        <CardHeader>
          <CardTitle>{chain.name}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="py-6 text-center text-sm text-muted-foreground">
            No holders found
          </div>
        </CardContent>
      </Card>
    )
  }

  const maxBal = parseFloat(String(holders[0].balance).replace(/,/g, '')) || 1
  const hasTags = !!holders[0]?.chains

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{chain.name}</CardTitle>
        <CardAction>
          <Badge variant="secondary">{holders.length} holders</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[40px] text-xs">#</TableHead>
              <TableHead className="text-xs">Address</TableHead>
              {hasTags && <TableHead className="text-xs w-[80px]">Chains</TableHead>}
              <TableHead className="text-xs text-right">Balance</TableHead>
              <TableHead className="text-xs text-right w-[90px]">%</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {holders.map((h, i) => {
              const pctValue = Math.min((parseFloat(String(h.balance).replace(/,/g, '')) / maxBal) * 100, 100)
              return (
                <TableRow key={h.address}>
                  <TableCell className="text-xs text-muted-foreground text-center">
                    {i + 1}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    <a
                      href={chain.explorer(h.address)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline"
                    >
                      {truncate(h.address)}
                    </a>
                  </TableCell>
                  {hasTags && (
                    <TableCell>
                      <div className="flex gap-0.5 flex-wrap">
                        {(h.chains || []).map(c => (
                          <Badge key={c} variant="outline" className="text-[9px] h-4 px-1 py-0">
                            {CHAIN_LABELS[c] || c}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                  )}
                  <TableCell className="font-mono text-xs text-right">
                    {formatBal(h.balance)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <span className="text-xs text-muted-foreground w-10 text-right">
                        {h.percentage?.toFixed?.(1) ?? h.percentage}%
                      </span>
                      <div className="w-12">
                        <Progress value={pctValue} className="h-1" />
                      </div>
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
