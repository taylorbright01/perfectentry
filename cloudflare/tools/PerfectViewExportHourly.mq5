#property strict
#property script_show_inputs
#property description "Exports broker H1 history only. No trades, no API requests. Importer must convert the broker clock to UTC."
input int HistoryYears=5;
input string SymbolPrefix="";
input string SymbolSuffix="";
input string Nas100BrokerSymbol="NAS100";
void OnStart(){
 if(HistoryYears<1||HistoryYears>7){Print("Choose 1–7 years.");return;}
 string pairs[];StringSplit("AUDCAD,AUDCHF,AUDNZD,AUDUSD,BTCUSD,CADJPY,CHFJPY,ETHUSD,EURAUD,EURCAD,EURGBP,EURJPY,EURNZD,EURUSD,GBPAUD,GBPCAD,GBPCHF,GBPJPY,GBPUSD,NAS100,NZDCAD,NZDCHF,NZDJPY,NZDUSD,USDCAD,USDCHF,USDJPY,XAGUSD,XAUUSD",',',pairs);
 FolderCreate("PerfectViewHistory");datetime finish=TimeTradeServer(),start=finish-(long)HistoryYears*366*86400;
 for(int i=0;i<ArraySize(pairs)&&!IsStopped();i++){
  string symbol=SymbolPrefix+pairs[i]+SymbolSuffix;if(pairs[i]=="NAS100")symbol=Nas100BrokerSymbol;
  if(!SymbolSelect(symbol,true)){Print("Perfect View history: unavailable ",pairs[i]);continue;}
  MqlRates rates[];ArraySetAsSeries(rates,false);int copied=-1;
  for(int attempt=0;attempt<30&&!IsStopped();attempt++){ResetLastError();copied=CopyRates(symbol,PERIOD_H1,start,finish,rates);if(copied>0)break;Sleep(500);}
  if(copied<=0){Print("Perfect View history: not ready ",pairs[i],". Download H1 history in MT5 and rerun.");continue;}
  string path="PerfectViewHistory\\"+pairs[i]+"_H1.csv";int handle=FileOpen(path,FILE_WRITE|FILE_CSV|FILE_ANSI,',',CP_UTF8);
  if(handle==INVALID_HANDLE){Print("Could not write ",path);continue;}
  FileWrite(handle,"date","time","open","high","low","close","tick_volume");int written=0;
  for(int j=0;j<copied;j++){
   if(rates[j].time+3600>finish)continue;
   FileWrite(handle,TimeToString(rates[j].time,TIME_DATE),TimeToString(rates[j].time,TIME_MINUTES),DoubleToString(rates[j].open,10),DoubleToString(rates[j].high,10),DoubleToString(rates[j].low,10),DoubleToString(rates[j].close,10),rates[j].tick_volume);written++;
  }
  FileFlush(handle);FileClose(handle);Print("Perfect View history: ",pairs[i]," exported ",written," H1 candles in broker clock. Earliest: ",TimeToString(rates[0].time,TIME_DATE));
 }
 Print("Files: MT5 File > Open Data Folder > MQL5 > Files > PerfectViewHistory. Check the broker's historical winter/summer UTC offsets before importing.");
}
