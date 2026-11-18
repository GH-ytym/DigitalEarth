<?xml version="1.0" encoding="UTF-8"?>
<StyledLayerDescriptor version="1.0.0"
  xmlns="http://www.opengis.net/sld"
  xmlns:ogc="http://www.opengis.net/ogc"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.opengis.net/sld http://schemas.opengis.net/sld/1.0.0/StyledLayerDescriptor.xsd">
  <NamedLayer>
    <Name>province_outline_dynamic</Name>
    <UserStyle>
      <Title>Adjustable province outlines</Title>
      <FeatureTypeStyle>
        <Rule>
          <PolygonSymbolizer>
            <Fill><CssParameter name="fill-opacity">0</CssParameter></Fill>
            <Stroke>
              <CssParameter name="stroke">
                <ogc:Function name="env">
                  <ogc:Literal>lineColor</ogc:Literal>
                  <ogc:Literal>#000000</ogc:Literal>
                </ogc:Function>
              </CssParameter>
              <CssParameter name="stroke-width">
                <ogc:Function name="env">
                  <ogc:Literal>lineWidth</ogc:Literal>
                  <ogc:Literal>1</ogc:Literal>
                </ogc:Function>
              </CssParameter>
            </Stroke>
          </PolygonSymbolizer>
        </Rule>
      </FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>
