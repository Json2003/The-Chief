export function chiefRecoveryDecision({healthy,listenerPresent,booting,failures,threshold=3}={}){
  if(healthy)return 'healthy';
  if(listenerPresent)return 'occupied-preserve';
  if(booting)return 'starting';
  return failures>=threshold?'start':'wait';
}
