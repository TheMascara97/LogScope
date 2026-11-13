#pragma once
#include <QByteArray>
struct TelnetDecoder {
 enum Mode {Data,Iac,Option,Sub,SubIac} mode=Data;unsigned char command=0;
 QByteArray decode(const QByteArray& input,QByteArray& reply){
  QByteArray output;
  for(unsigned char b:input){
   switch(mode){
    case Data: if(b==255)mode=Iac;else output.append(char(b));break;
    case Iac: if(b==255){output.append(char(b));mode=Data;}else if(b>=251&&b<=254){command=b;mode=Option;}else if(b==250)mode=Sub;else mode=Data;break;
    case Option: if(command==251||command==253){reply.append(char(255));reply.append(char(command==251?254:252));reply.append(char(b));}mode=Data;break;
    case Sub: if(b==255)mode=SubIac;break;
    case SubIac: mode=b==240?Data:Sub;break;
   }
  }
  return output;
 }
};
